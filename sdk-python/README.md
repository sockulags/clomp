# clomp-sdk (Python)

Python client for [clomp](https://github.com/sockulags/clomp) — a tamper-evident audit trail for security work.

Zero dependencies (standard library only), Python 3.10+.

## Install

```bash
pip install clomp-sdk
```

## Usage

```python
from clomp import Clomp

client = Clomp(
    api_url="https://clomp.internal.example.com",  # or $CLOMP_API_URL
    api_key="clomp_live_...",                      # or $CLOMP_API_KEY
    default_actor={"type": "service", "id": "billing-api"},
)

# Record audit events (queued, sent in order by a background thread)
client.record(
    "access.revoked",
    target={"type": "user", "id": "u-42"},
    context={"reason": "offboarding"},
)

client.record(
    "patch.applied",
    actor={"type": "user", "id": "lucas"},   # overrides default_actor
    target={"type": "system", "id": "web-01"},
    occurred_at="2026-07-13T06:00:00Z",      # backfill is allowed and visible
)

# Guaranteed delivery before shutdown
client.close()
```

The client is also a context manager — `with Clomp(...) as client:` flushes on exit.

### Verify the chain

```python
result = client.verify()
if not result["intact"]:
    print(f"chain broken at sequence {result['firstBreak']}: {result['reason']}")
```

`verify(from_sequence=..., to_sequence=...)` restricts the range. Unlike
`record()`, it raises `clomp.ClompError` on network failure or a non-2xx
response.

## Behavior

Mirrors [`@clomp/sdk-node`](https://github.com/sockulags/clomp/tree/main/sdk-nodejs):

- Events are queued and sent **oldest first** — arrival order at the server
  defines the position in the hash chain.
- Network failures, 5xx and rate limits keep the event queued for retry with
  exponential backoff; validation/auth rejections drop the event (logged on
  the `clomp` logger).
- The queue is bounded (`max_queue_length`, default 1000); when full, the
  oldest event is dropped. `record()` never raises into your application.
- The background flush thread is a daemon — it never keeps your process
  alive. Call `close()` (or use the context manager) to guarantee delivery,
  or opt in to `Clomp.register_shutdown_handlers()` to flush all clients
  (bounded to about 2 seconds) at interpreter exit and on
  `SIGINT`/`SIGTERM`.
- `occurred_at` accepts an ISO 8601 string or a `datetime`; both are
  normalized to UTC. Naive datetimes are interpreted as local time, like
  the Node SDK's `new Date()`.

## Options

| Option | Default | Description |
|---|---|---|
| `api_url` | `$CLOMP_API_URL` or `http://localhost:3000` | clomp server base URL |
| `api_key` | `$CLOMP_API_KEY` | machine API key (created by an admin in the UI) |
| `default_actor` | — | actor used when `record()` gets none |
| `flush_interval` | `2.0` s | periodic flush; `0` disables the thread (flush manually) |
| `max_queue_length` | `1000` | bounded queue size |
| `timeout` | `10.0` s | per-request timeout |

## Tests

Self-contained — a stdlib stub HTTP server stands in for the backend:

```bash
python test/test_sdk.py
# or
python -m pytest test/
```
