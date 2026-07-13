# @clomp/sdk-node

Node.js client for [clomp](../README.md) — a tamper-evident audit trail for security work.

## Install

```bash
npm install @clomp/sdk-node
```

## Usage

```javascript
const Clomp = require('@clomp/sdk-node');

const clomp = new Clomp({
  apiUrl: 'https://clomp.internal.example.com',
  apiKey: process.env.CLOMP_API_KEY,          // clomp_live_...
  defaultActor: { type: 'service', id: 'billing-api' }
});

// Record audit events (queued, sent in order)
clomp.record('access.revoked', {
  target: { type: 'user', id: 'u-42' },
  context: { reason: 'offboarding' }
});

clomp.record('patch.applied', {
  actor: { type: 'user', id: 'lucas' },       // overrides defaultActor
  target: { type: 'system', id: 'web-01' },
  occurredAt: '2026-07-13T06:00:00Z'          // backfill is allowed and visible
});

// Guaranteed delivery before shutdown
await clomp.destroy();
```

## Behavior

- Events are queued and sent **oldest first** — arrival order at the server
  defines the position in the hash chain.
- Network failures and rate limits keep the event queued for retry;
  validation/auth rejections drop the event (set `CLOMP_DEBUG=1` to see why).
- The queue is bounded (`maxQueueLength`, default 1000); when full, the oldest
  event is dropped. The SDK never throws into your application.
- `Clomp.registerShutdownHandlers()` (opt-in) flushes all clients on
  SIGINT/SIGTERM without hijacking process exit.

## Options

| Option | Default | Description |
|---|---|---|
| `apiUrl` | `$CLOMP_API_URL` | clomp server base URL |
| `apiKey` | `$CLOMP_API_KEY` | machine API key (created by an admin in the UI) |
| `defaultActor` | — | actor used when `record()` gets none |
| `flushInterval` | `2000` ms | periodic flush; `0` disables (flush manually) |
| `maxQueueLength` | `1000` | bounded queue size |
| `timeoutMs` | `10000` | per-request timeout |
