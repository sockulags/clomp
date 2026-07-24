# @clomp/sdk-node

Node.js client for [clomp](../README.md) — a tamper-evident audit trail for security work.

## Install

```bash
npm install @clomp/sdk-node
```

Requires Node.js 24 or newer.

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

## CLI

The package ships a dependency-free `clomp` command (Node ≥ 18):

```bash
npm install -g @clomp/sdk-node

export CLOMP_API_URL=https://clomp.internal.example.com
export CLOMP_API_KEY=clomp_live_...

# record from cron, CI or a runbook
clomp record patch.applied --actor service:ci --target system:web-01
clomp record access.review.completed --actor user:lucas --target scope:all-prod \
  --evidence ./review-q3.pdf                # uploads and chains the file's sha256

# monitoring-friendly checks (non-zero exit on failure)
clomp verify                                # 1 if the chain is broken
clomp schedules --fail-on-overdue           # 1 if a scheduled control is overdue

clomp export --out backup.jsonl             # offline-verifiable export
clomp catalog                               # seeded SOC 2 / NIS2 action catalog
```

### Offline verification (no server, no API key)

```bash
# recompute the chain in an export — what the auditor runs
clomp verify-file clomp-export.jsonl

# compare an archived anchoring checkpoint (email text or webhook JSON)
# against an export: detects history rewritten after the anchor
clomp anchor-check checkpoint-digest.txt clomp-export.jsonl
```

Both exit `0` on success and `1` on any mismatch.
