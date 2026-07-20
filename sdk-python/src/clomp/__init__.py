"""clomp Python client — records tamper-evident audit events.

Mirrors the semantics of @clomp/sdk-node: events are queued in memory and
sent oldest-first (arrival order at the server defines the position in the
hash chain), network trouble keeps events queued for retry with backoff,
and the SDK never raises into the host application from ``record()``.

    from clomp import Clomp

    client = Clomp(
        api_url="https://clomp.internal.example.com",
        api_key="clomp_live_...",
        default_actor={"type": "service", "id": "billing-api"},
    )
    client.record("access.revoked", target={"type": "user", "id": "u-42"})
    client.close()  # flush pending events before exit
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import signal
import threading
import urllib.error
import urllib.parse
import urllib.request
import weakref
from collections import deque
from datetime import datetime, timezone
from typing import Any

__all__ = ["Clomp", "ClompError", "__version__"]
__version__ = "0.2.0"

logger = logging.getLogger("clomp")

# Cap for the exponential retry backoff between failed background flushes.
# (When flush_interval itself is larger, the interval is the cap.)
_MAX_BACKOFF_SECONDS = 60.0

# Maximum time the opt-in shutdown handler spends flushing all clients,
# mirroring the 2-second budget of the Node SDK's registerShutdownHandlers().
_SHUTDOWN_FLUSH_SECONDS = 2.0

# Live client instances, so the optional shutdown handler can flush them all.
_client_instances: weakref.WeakSet[Clomp] = weakref.WeakSet()
_shutdown_handler_registered = False


class ClompError(Exception):
    """Raised by ``verify()`` when the request fails or the server rejects it.

    Attributes:
        status: HTTP status code, or ``None`` for network-level failures.
        body: Parsed JSON error body when the server returned one.
    """

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def _isoformat(value: str | datetime) -> str:
    """Normalize occurred_at to an ISO 8601 UTC string.

    Mirrors the Node SDK's ``new Date(x).toISOString()``: strings are parsed
    as ISO 8601 and re-emitted in UTC; naive datetimes are interpreted as
    local time. Raises ValueError for unparseable strings (the event is then
    rejected in ``record()`` before it is queued, like in Node).
    """
    if isinstance(value, str):
        # Python 3.10's fromisoformat does not accept a trailing "Z".
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    # astimezone() on a naive datetime interprets it as local time,
    # matching JavaScript's new Date() semantics.
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class Clomp:
    """Client for a clomp server. Thread-safe.

    Args:
        api_url: Base URL of the clomp server. Defaults to ``$CLOMP_API_URL``
            or ``http://localhost:3000``.
        api_key: Machine API key (``clomp_live_...``). Defaults to
            ``$CLOMP_API_KEY``. Without a key, events are queued but never
            sent (a warning is logged).
        default_actor: Actor dict (``{"type", "id", ...}``) used when
            ``record()`` gets none.
        flush_interval: Seconds between periodic background flushes.
            ``0`` disables the background thread (flush manually).
        max_queue_length: Bounded queue size; when full, the oldest event
            is dropped.
        timeout: Per-request timeout in seconds.
    """

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        default_actor: dict[str, Any] | None = None,
        flush_interval: float = 2.0,
        max_queue_length: int = 1000,
        timeout: float = 10.0,
    ):
        self.api_url = (api_url or os.environ.get("CLOMP_API_URL") or "http://localhost:3000").rstrip("/")
        self.api_key = api_key or os.environ.get("CLOMP_API_KEY")
        self.default_actor = default_actor

        if not self.api_key:
            logger.warning("clomp SDK: No API key provided. Events will not be sent.")

        # FIFO queue: arrival order at the server defines chain order, so
        # events are always sent one at a time, oldest first.
        self._queue: deque[dict[str, Any]] = deque()
        self._queue_lock = threading.Lock()
        self._flush_lock = threading.Lock()
        # Falsy/invalid values fall back to the defaults, like the Node SDK's
        # `options.maxQueueLength || 1000` / `options.timeoutMs || 10000`.
        self.max_queue_length = max_queue_length if max_queue_length and max_queue_length > 0 else 1000
        self.flush_interval = flush_interval
        self.timeout = timeout if timeout and timeout > 0 else 10.0

        self._consecutive_failures = 0
        self._closed = False
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None

        # Start the periodic flush thread. It is a daemon so the SDK never
        # keeps the host process alive on its own (mirrors Node's unref'd timer).
        if flush_interval > 0:
            self._worker = threading.Thread(
                target=self._worker_loop, name="clomp-flush", daemon=True
            )
            self._worker.start()

        _client_instances.add(self)

    # ------------------------------------------------------------------ #
    # Recording

    def record(
        self,
        action: str,
        *,
        actor: dict[str, Any] | None = None,
        target: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        evidence: list[dict[str, Any]] | None = None,
        occurred_at: str | datetime | None = None,
    ) -> None:
        """Queue an audit event. Never raises into the caller.

        Args:
            action: Namespaced action, e.g. ``"access.review.completed"``.
            actor: ``{"type", "id", ...}``; falls back to ``default_actor``.
            target: ``{"type", "id", ...}`` the action applied to.
            context: Free-form metadata dict.
            evidence: List of ``{"filename", "sha256", "size"}`` dicts.
            occurred_at: When it happened (ISO 8601 string or ``datetime``;
                naive datetimes are interpreted as local time, like the Node
                SDK's ``new Date()``); defaults to now on the server.
        """
        try:
            resolved_actor = actor or self.default_actor
            if (
                not action
                or not isinstance(resolved_actor, dict)
                or not resolved_actor.get("type")
                or not resolved_actor.get("id")
            ):
                raise ValueError(
                    'record() needs an action and an actor with {"type", "id"} (or a default_actor)'
                )

            event: dict[str, Any] = {"action": action, "actor": resolved_actor}
            if target is not None:
                event["target"] = target
            if context is not None:
                event["context"] = context
            if evidence is not None:
                event["evidence"] = evidence
            if occurred_at is not None:
                event["occurred_at"] = _isoformat(occurred_at)

            with self._queue_lock:
                if len(self._queue) >= self.max_queue_length:
                    # Drop the oldest event rather than growing without bound;
                    # an audit SDK must never take the host application down.
                    self._queue.popleft()
                    logger.warning("clomp SDK: queue full, dropped oldest event")
                self._queue.append(event)
        except Exception as exc:  # noqa: BLE001 — SDK errors must never crash the app
            logger.error("clomp SDK: Failed to queue event: %s", exc)

    @property
    def pending(self) -> int:
        """Number of events waiting to be sent."""
        with self._queue_lock:
            return len(self._queue)

    # ------------------------------------------------------------------ #
    # Flushing

    def flush(self) -> None:
        """Send all queued events now, oldest first.

        Events that fail with a retryable error (network trouble, 5xx, 429)
        stay at the front of the queue and are retried on the next flush.
        Permanent rejections (other 4xx) are dropped so they cannot wedge
        the queue. Concurrent calls are serialized. Never raises.
        """
        with self._flush_lock:
            self._drain()

    def _drain(self) -> None:
        if not self.api_key:
            return

        while True:
            with self._queue_lock:
                if not self._queue:
                    self._consecutive_failures = 0
                    return
                event = self._queue[0]

            try:
                self._request("POST", "/api/events", body=event)
            except urllib.error.HTTPError as exc:
                status = exc.code
                detail = _error_detail(exc)
                if 400 <= status < 500 and status != 429:
                    # Rejected permanently (validation/auth) — drop it.
                    logger.error("clomp SDK: event rejected (%s): %s", status, detail)
                else:
                    # Server error or rate limit — keep the event, retry later.
                    self._consecutive_failures += 1
                    logger.warning("clomp SDK: send failed (%s), will retry: %s", status, detail)
                    return
            except Exception as exc:  # noqa: BLE001 — network trouble, timeouts
                self._consecutive_failures += 1
                logger.warning("clomp SDK: send failed, will retry: %s", exc)
                return
            else:
                self._consecutive_failures = 0

            # Sent or permanently rejected: remove it by identity, not by
            # position — a concurrent record() on a full queue may have
            # already evicted this event as the oldest.
            with self._queue_lock:
                if self._queue and self._queue[0] is event:
                    self._queue.popleft()

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            # Exponential backoff after consecutive failed flushes.
            delay = min(
                self.flush_interval * (2 ** self._consecutive_failures),
                max(_MAX_BACKOFF_SECONDS, self.flush_interval),
            )
            if self._stop.wait(delay):
                return
            try:
                self.flush()
            except Exception:  # noqa: BLE001 — the worker must never die
                logger.exception("clomp SDK: unexpected error in background flush")

    # ------------------------------------------------------------------ #
    # Verification

    def verify(
        self, from_sequence: int | None = None, to_sequence: int | None = None
    ) -> dict[str, Any]:
        """Ask the server to recompute the hash chain (``GET /api/verify``).

        Args:
            from_sequence: First sequence number to verify (server default: 1).
            to_sequence: Last sequence number to verify (server default: head).

        Returns:
            The verification result, e.g. ``{"intact": True, "verified": 128,
            "checkpoint": {...}}``. When the chain is broken, ``intact`` is
            ``False`` and ``firstBreak``/``reason`` describe the break.

        Raises:
            ClompError: On network failure or a non-2xx response.
        """
        params: dict[str, int] = {}
        if from_sequence is not None:
            params["from"] = from_sequence
        if to_sequence is not None:
            params["to"] = to_sequence

        try:
            return self._request("GET", "/api/verify", params=params or None)
        except urllib.error.HTTPError as exc:
            body = _error_body(exc)
            message = body.get("error") if isinstance(body, dict) else None
            raise ClompError(
                message or f"verify failed with HTTP {exc.code}", status=exc.code, body=body
            ) from exc
        except Exception as exc:
            raise ClompError(f"verify failed: {exc}") from exc

    # ------------------------------------------------------------------ #
    # Lifecycle

    def close(self) -> None:
        """Stop the background thread and flush pending events.

        Call during application shutdown to ensure delivery. Idempotent.
        """
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        if self._worker is not None:
            self._worker.join(timeout=self.timeout)
            self._worker = None
        _client_instances.discard(self)
        self.flush()

    def __enter__(self) -> Clomp:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @staticmethod
    def register_shutdown_handlers() -> None:
        """Opt-in: flush all client instances before the process terminates.

        Registers an ``atexit`` hook plus ``SIGINT``/``SIGTERM`` handlers
        (where possible) that close — and therefore flush — every live
        client, bounded to about 2 seconds like the Node SDK. After a signal
        the previous handler (or the default behavior) is invoked, so normal
        termination is preserved. The SDK never installs process-wide
        handlers on its own.
        """
        global _shutdown_handler_registered
        if _shutdown_handler_registered:
            return
        _shutdown_handler_registered = True

        atexit.register(_flush_all_clients)

        # atexit does not run on an unhandled SIGTERM (the common container
        # shutdown path), so hook the signals too. signal.signal() only works
        # from the main thread — skip silently elsewhere.
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                previous = signal.getsignal(signum)

                def _handler(sig: int, frame: Any, _previous: Any = previous) -> None:
                    _flush_all_clients()
                    if callable(_previous):
                        _previous(sig, frame)
                    else:
                        signal.signal(sig, signal.SIG_DFL)
                        os.kill(os.getpid(), sig)

                signal.signal(signum, _handler)
            except (ValueError, OSError, AttributeError):  # noqa: PERF203
                pass

    # ------------------------------------------------------------------ #
    # HTTP plumbing (stdlib only)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        url = self.api_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)

        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"clomp-sdk-python/{__version__}",
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            raw = response.read()
        return json.loads(raw) if raw else None


def _flush_all_clients() -> None:
    """Close (and flush) every live client, bounded to ~2 seconds total."""
    def _close_all() -> None:
        for instance in list(_client_instances):
            try:
                instance.close()
            except Exception as exc:  # noqa: BLE001
                logger.error("clomp SDK: error flushing events on shutdown: %s", exc)

    worker = threading.Thread(target=_close_all, name="clomp-shutdown-flush", daemon=True)
    worker.start()
    worker.join(_SHUTDOWN_FLUSH_SECONDS)


def _error_body(exc: urllib.error.HTTPError) -> Any:
    """Best-effort parse of an HTTPError's JSON body (raw string as fallback)."""
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _error_detail(exc: urllib.error.HTTPError) -> str:
    """One-line human-readable detail for logging an HTTPError."""
    body = _error_body(exc)
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    return str(body or exc.reason)
