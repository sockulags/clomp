# Node.js SDK

```bash
npm install @clomp/sdk-node
```

Requires Node.js 24 or newer.

```js
const Clomp = require('@clomp/sdk-node');

const clomp = new Clomp({
  apiUrl: 'https://clomp.example.com',   // or CLOMP_API_URL
  apiKey: process.env.CLOMP_API_KEY,     // clomp_live_...
  defaultActor: { type: 'service', id: 'billing-api' }
});

clomp.record('access.revoked', {
  target: { type: 'user', id: 'u-42' },
  context: { reason: 'offboarding' }
});

await clomp.destroy(); // flush pending events before exit
```

## Design principles

- **Never crash the host app.** `record()` catches its own errors; a full
  queue drops the oldest event rather than growing without bound.
- **Order preserved.** Events are queued FIFO and sent one at a time,
  oldest first — arrival order at the server defines chain order.
- **Sensible retries.** Network errors and `429` keep the event queued for
  the next flush; permanent rejections (validation, auth) drop it (set
  `CLOMP_DEBUG=1` to log why).
- **No process interference by default.** The flush timer is `unref`'d.
  Optionally call `Clomp.registerShutdownHandlers()` to flush all clients on
  `SIGINT`/`SIGTERM`.

## API

### `new Clomp(options)`

| Option | Default | |
|---|---|---|
| `apiUrl` | `CLOMP_API_URL` or `http://localhost:3000` | |
| `apiKey` | `CLOMP_API_KEY` | Without it, events are queued but never sent (a warning is printed) |
| `defaultActor` | `null` | Used when `record()` gets no `actor` |
| `flushInterval` | `2000` ms | `0` disables the timer (flush manually) |
| `maxQueueLength` | `1000` | Oldest events are dropped beyond this |
| `timeoutMs` | `10000` | Per-request timeout |

### `clomp.record(action, fields?)`

Queue an event. `fields`: `actor`, `target`, `context`,
`evidence` (`[{ filename, sha256, size }]`), `occurredAt` (string or `Date`).

### `await clomp.flush()`

Send all queued events now. Concurrent calls coalesce.

### `await clomp.destroy()`

Stop the timer and flush. Await during shutdown for guaranteed delivery.

### `Clomp.registerShutdownHandlers()`

Opt-in `SIGINT`/`SIGTERM` handlers that flush every client instance (max 2 s)
and then re-raise the signal — default termination behavior is preserved.
