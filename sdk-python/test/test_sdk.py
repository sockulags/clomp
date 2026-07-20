"""Self-contained SDK tests: spin up a stub HTTP server, record events and
assert what arrives. No live backend needed.

Run with either:
    python test/test_sdk.py
    python -m pytest test/
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from clomp import Clomp, ClompError  # noqa: E402


VERIFY_RESULT = {
    "intact": True,
    "verified": 3,
    "checkpoint": {"sequence": 3, "signed_at": "2026-07-01T06:00:00.000Z", "signature_valid": True},
}


class StubHandler(BaseHTTPRequestHandler):
    """Stub clomp server: captures POST /api/events, serves GET /api/verify."""

    server: "StubServer"

    def log_message(self, *args):  # silence request logging
        pass

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        with self.server.lock:
            if self.server.fail_next > 0:
                self.server.fail_next -= 1
                self._send_json(500, {"error": "boom"})
                return
            if self.server.reject_next > 0:
                self.server.reject_next -= 1
                self._send_json(400, {"error": "invalid"})
                return
            self.server.received.append(
                {"path": self.path, "api_key": self.headers.get("X-API-Key"), "body": body}
            )
            sequence = len(self.server.received)
        self._send_json(201, {"event": {"sequence": sequence}, "known_action": True})

    def do_GET(self):
        if self.path.startswith("/api/verify"):
            with self.server.lock:
                self.server.verify_queries.append(self.path)
                if self.server.verify_status != 200:
                    self._send_json(self.server.verify_status, {"error": "verify says no"})
                    return
            self._send_json(200, VERIFY_RESULT)
        else:
            self._send_json(404, {"error": "not found"})


class StubServer(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), StubHandler)
        self.lock = threading.Lock()
        self.received: list[dict] = []
        self.verify_queries: list[str] = []
        self.fail_next = 0
        self.reject_next = 0
        self.verify_status = 200

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class ClompSDKTest(unittest.TestCase):
    server: StubServer

    @classmethod
    def setUpClass(cls):
        cls.server = StubServer()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        with self.server.lock:
            self.server.received.clear()
            self.server.verify_queries.clear()
            self.server.fail_next = 0
            self.server.reject_next = 0
            self.server.verify_status = 200
        self.client = self.make_client()

    def make_client(self, **overrides) -> Clomp:
        """Client against the stub server; flush_interval=0 by default so no
        background thread races the assertions. Closed automatically."""
        options = {
            "api_url": self.server.url,
            "api_key": "clomp_live_test",
            "default_actor": {"type": "service", "id": "test-suite"},
            "flush_interval": 0,
            **overrides,
        }
        client = Clomp(**options)
        self.addCleanup(client.close)
        return client

    def test_events_sent_fifo_with_api_key_header(self):
        self.client.record("patch.applied", target={"type": "system", "id": "web-01"})
        self.client.record(
            "backup.tested", context={"ok": True}, occurred_at="2026-07-01T06:00:00Z"
        )
        self.client.flush()

        received = self.server.received
        self.assertEqual(len(received), 2, "both events delivered")
        self.assertEqual(received[0]["path"], "/api/events")
        self.assertEqual(received[0]["api_key"], "clomp_live_test")
        self.assertEqual(received[0]["body"]["action"], "patch.applied")
        self.assertEqual(received[0]["body"]["actor"], {"type": "service", "id": "test-suite"})
        self.assertEqual(received[0]["body"]["target"], {"type": "system", "id": "web-01"})
        self.assertEqual(received[1]["body"]["action"], "backup.tested")
        self.assertEqual(received[1]["body"]["occurred_at"], "2026-07-01T06:00:00Z")

    def test_occurred_at_normalized_to_utc(self):
        self.client.record(
            "backup.tested", occurred_at=datetime(2026, 7, 1, 6, 0, 0, tzinfo=timezone.utc)
        )
        self.client.record("backup.tested", occurred_at="2026-07-01T08:00:00+02:00")
        self.client.flush()
        self.assertEqual(self.server.received[0]["body"]["occurred_at"], "2026-07-01T06:00:00Z")
        self.assertEqual(
            self.server.received[1]["body"]["occurred_at"],
            "2026-07-01T06:00:00Z",
            "offset strings are normalized to UTC like Node's toISOString()",
        )

    def test_unparseable_occurred_at_never_raises_and_is_not_queued(self):
        self.client.record("backup.tested", occurred_at="yesterday")
        self.assertEqual(self.client.pending, 0, "invalid occurred_at rejected before queueing")

    def test_omitted_fields_not_sent(self):
        self.client.record("patch.applied")
        self.client.flush()
        body = self.server.received[0]["body"]
        self.assertEqual(set(body), {"action", "actor"}, "no null/omitted fields in payload")

    def test_server_error_keeps_event_queued_for_retry(self):
        with self.server.lock:
            self.server.fail_next = 1
        self.client.record("incident.opened")
        self.client.flush()
        self.assertEqual(self.client.pending, 1, "event retained after 500")

        self.client.flush()
        self.assertEqual(self.client.pending, 0, "event delivered on retry")
        self.assertEqual(self.server.received[0]["body"]["action"], "incident.opened")

    def test_permanent_rejection_dropped(self):
        with self.server.lock:
            self.server.reject_next = 1
        self.client.record("bad.event")
        self.client.record("good.event")
        self.client.flush()
        self.assertEqual(self.client.pending, 0, "400-rejected event dropped, queue not wedged")
        self.assertEqual(len(self.server.received), 1)
        self.assertEqual(self.server.received[0]["body"]["action"], "good.event")

    def test_record_without_actor_never_raises(self):
        bare = self.make_client(default_actor=None)
        bare.record("a.b")  # no actor and no default_actor
        self.assertEqual(bare.pending, 0, "invalid event not queued")

    def test_queue_bounded_drops_oldest(self):
        small = self.make_client(max_queue_length=2)
        small.record("event.one")
        small.record("event.two")
        small.record("event.three")
        self.assertEqual(small.pending, 2)
        small.flush()
        actions = [r["body"]["action"] for r in self.server.received]
        self.assertEqual(actions, ["event.two", "event.three"], "oldest event dropped")

    def test_falsy_options_fall_back_to_defaults(self):
        # Mirrors Node's `options.maxQueueLength || 1000` / `timeoutMs || 10000`.
        client = self.make_client(max_queue_length=0, timeout=0)
        self.assertEqual(client.max_queue_length, 1000)
        self.assertEqual(client.timeout, 10.0)
        client.record("patch.applied")
        client.flush()
        self.assertEqual(self.server.received[0]["body"]["action"], "patch.applied")

    def test_no_api_key_queues_but_never_sends(self):
        env_key = os.environ.pop("CLOMP_API_KEY", None)
        try:
            silent = self.make_client(api_key=None)
            silent.record("patch.applied")
            silent.flush()
            self.assertEqual(silent.pending, 1, "event stays queued without an API key")
            self.assertEqual(len(self.server.received), 0)
        finally:
            if env_key is not None:
                os.environ["CLOMP_API_KEY"] = env_key

    def test_background_flush_delivers_without_manual_flush(self):
        auto = self.make_client(flush_interval=0.05)
        auto.record("patch.applied")
        for _ in range(100):  # up to ~5 s on a slow machine
            if auto.pending == 0:
                break
            time.sleep(0.05)
        self.assertEqual(auto.pending, 0, "background thread flushed the queue")

    def test_close_flushes_pending_events(self):
        client = self.make_client()
        client.record("shutdown.event")
        client.close()
        self.assertEqual(self.server.received[-1]["body"]["action"], "shutdown.event")
        client.close()  # idempotent

    def test_context_manager_flushes_on_exit(self):
        with self.make_client() as client:
            client.record("ctx.event")
        self.assertEqual(self.server.received[-1]["body"]["action"], "ctx.event")

    def test_verify_returns_parsed_result(self):
        result = self.client.verify()
        self.assertEqual(result, VERIFY_RESULT)
        self.assertEqual(self.server.verify_queries, ["/api/verify"])

    def test_verify_passes_range_params(self):
        self.client.verify(from_sequence=2, to_sequence=10)
        self.assertEqual(self.server.verify_queries, ["/api/verify?from=2&to=10"])

    def test_verify_raises_clomp_error_on_http_error(self):
        with self.server.lock:
            self.server.verify_status = 401
        with self.assertRaises(ClompError) as ctx:
            self.client.verify()
        self.assertEqual(ctx.exception.status, 401)
        self.assertIn("verify says no", str(ctx.exception))

    def test_verify_raises_clomp_error_on_network_failure(self):
        unreachable = self.make_client(api_url="http://127.0.0.1:1", timeout=1)
        with self.assertRaises(ClompError) as ctx:
            unreachable.verify()
        self.assertIsNone(ctx.exception.status)


if __name__ == "__main__":
    unittest.main(verbosity=2)
