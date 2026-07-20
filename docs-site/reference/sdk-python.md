# Python SDK

```bash
pip install clomp-sdk
```

Zero dependencies (standard library only), Python 3.10+. Mirrors the
semantics of the [Node.js SDK](/reference/sdk).

```python
import os
from clomp import Clomp

client = Clomp(
    api_url="https://clomp.example.com",   # or CLOMP_API_URL
    api_key=os.environ["CLOMP_API_KEY"],   # clomp_live_...
    default_actor={"type": "service", "id": "billing-api"},
)

client.record(
    "access.revoked",
    target={"type": "user", "id": "u-42"},
    context={"reason": "offboarding"},
)

client.close()  # flush pending events before exit
```

## Design principles

- **Never crash the host app.** `record()` catches its own errors; a full
  queue drops the oldest event rather than growing without bound.
- **Order preserved.** Events are queued FIFO and sent one at a time,
  oldest first — arrival order at the server defines chain order.
- **Sensible retries.** Network errors, `5xx` and `429` keep the event
  queued; the background thread retries with exponential backoff. Permanent
  rejections (validation, auth) drop the event, logged on the `clomp` logger.
- **No process interference by default.** The flush thread is a daemon and
  never keeps your process alive. Optionally call
  `Clomp.register_shutdown_handlers()` to flush all clients at interpreter
  exit.

## API

### `Clomp(...)`

| Option | Default | |
|---|---|---|
| `api_url` | `CLOMP_API_URL` or `http://localhost:3000` | |
| `api_key` | `CLOMP_API_KEY` | Without it, events are queued but never sent (a warning is logged) |
| `default_actor` | `None` | Used when `record()` gets no `actor` |
| `flush_interval` | `2.0` s | `0` disables the background thread (flush manually) |
| `max_queue_length` | `1000` | Oldest events are dropped beyond this |
| `timeout` | `10.0` s | Per-request timeout |

### `client.record(action, *, actor=None, target=None, context=None, evidence=None, occurred_at=None)`

Queue an event. `evidence` is a list of `{"filename", "sha256", "size"}`
dicts; `occurred_at` accepts an ISO 8601 string or a `datetime`, normalized
to UTC (naive datetimes are interpreted as local time, like the Node SDK's
`new Date()`). Never raises.

### `client.flush()`

Send all queued events now. Concurrent calls are serialized. Never raises.

### `client.verify(from_sequence=None, to_sequence=None)`

Call `GET /api/verify` and return the parsed result, e.g.
`{"intact": True, "verified": 128, "checkpoint": {...}}`. Raises
`clomp.ClompError` (with `.status` and `.body`) on failure — verification
is the one place where you want loud errors.

### `client.close()`

Stop the flush thread and flush. Call during shutdown for guaranteed
delivery; also available as a context manager (`with Clomp(...) as client:`).

### `Clomp.register_shutdown_handlers()`

Opt-in `atexit` hook plus `SIGINT`/`SIGTERM` handlers that close (and
therefore flush) every live client instance, bounded to about 2 seconds —
mirroring the Node SDK's `registerShutdownHandlers()`.
