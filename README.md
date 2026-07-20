# clomp

[![CI](https://github.com/sockulags/clomp/actions/workflows/ci.yml/badge.svg)](https://github.com/sockulags/clomp/actions/workflows/ci.yml)
[![Security](https://github.com/sockulags/clomp/actions/workflows/security.yml/badge.svg)](https://github.com/sockulags/clomp/actions/workflows/security.yml)
[![Docs](https://github.com/sockulags/clomp/actions/workflows/docs.yml/badge.svg)](https://sockulags.github.io/clomp/)
[![npm](https://img.shields.io/npm/v/%40clomp%2Fsdk-node?label=%40clomp%2Fsdk-node)](https://www.npmjs.com/package/@clomp/sdk-node)

**Documentation: [sockulags.github.io/clomp](https://sockulags.github.io/clomp/)** —
guide, operations handbook, REST/CLI/SDK reference, hash-chain spec and threat model.
Where it's headed: [ROADMAP.md](ROADMAP.md).

**A tamper-evident audit trail for security work.** clomp lets an organization
*prove* — not just claim — that its security activities happen: access reviews,
patches, incident handling, backup tests, training. Every event is chained with
SHA-256 hashes, checkpoints are signed with Ed25519, and exports verify offline.
Built for SOC 2 and NIS2 evidence. Self-hosted, open source (MIT), no paywalls.

Boring on purpose: no dashboards, no AI. Just a ledger that cannot be rewritten,
and a report that holds up in an audit.

## What it looks like

| Ledger | Scheduled controls |
|---|---|
| ![Ledger](docs/screenshots/ledger.png) | ![Scheduled controls](docs/screenshots/schedules.png) |

The PDF the auditor gets: [docs/sample-report.pdf](docs/sample-report.pdf) —
chain integrity statement, scheduled-controls status, activity summary mapped
to SOC 2 / NIS2, full event list with hashes. Generate your own demo data with
`node backend/scripts/seed-demo.js`.

## How it works

```mermaid
flowchart LR
    subgraph Writers
        UI1["People — web UI<br/>(access reviews, incidents, training)"]
        SDK["Machines — Node SDK / REST<br/>(clomp_live_* API keys, stored hashed)"]
    end

    subgraph Core["clomp backend — Express + PostgreSQL"]
        CHAIN["Append-only event chain<br/>hash = SHA-256(prev_hash ‖ canonical event)"]
        CP["Nightly Ed25519-signed<br/>checkpoints of the chain tip"]
        VER["GET /api/verify<br/>recomputes the chain"]
    end

    subgraph Readers
        AUD["Auditor — read-only role"]
        EXP["Exports: JSONL (offline-verifiable)<br/>+ PDF mapped to SOC 2 / NIS2"]
    end

    UI1 --> CHAIN
    SDK --> CHAIN
    CHAIN --> CP
    CHAIN --> VER
    CHAIN --> EXP
    AUD --> EXP
```

- **Append-only at the database level** — a trigger rejects `UPDATE`/`DELETE`
  on events for every role, superuser included. History cannot be edited, only extended.
- **Tamper-evident** — each event embeds the hash of its predecessor. Change one
  byte anywhere and `verify` pinpoints the first broken sequence number.
- **Backfill is a feature** — `occurred_at` (when it happened) and `recorded_at`
  (when it was logged) are both first-class and both hashed. Late entries are
  allowed and visible, exactly what an auditor wants.
- **Evidence with teeth** — uploaded files are content-addressed by SHA-256 and the
  hash is part of the event, so the attachment is as tamper-evident as the entry.
- **Verifiable without trusting the server** — the JSONL export carries the full
  chain and signed checkpoints; `scripts/verify-export.js` checks it on an
  auditor's laptop with no access to your installation.
- **External anchoring (opt-in)** — every nightly checkpoint can be emailed to
  the auditor and/or POSTed to a webhook (`ANCHOR_EMAIL_TO`,
  `ANCHOR_WEBHOOK_URL` in `.env`). An archived checkpoint outside the server
  means even root access cannot rewrite history undetected.
- **Roles that match an audit** — `admin`, `editor`, `auditor` (read-only + export).
  Passwords are argon2id, TOTP with single-use recovery codes is built in, and
  passkeys (WebAuthn) can be enabled on HTTPS installs with `WEBAUTHN_ORIGIN`.
- **Retention without breaking the chain** — a privileged script prunes old
  events by cutting only at a signed checkpoint, archiving the range to
  verifiable JSONL first, and appending the prune itself to the chain. See
  [docs/retention.md](docs/retention.md).
- **Scheduled controls** — declare how often an activity must be logged
  ("access review quarterly") and clomp surfaces what's overdue, in the UI and
  in the PDF report. The chain proves recorded history is genuine; schedules
  expose what should have been recorded but wasn't. Changes to the schedule
  are themselves chain events.

## Try it in 2 minutes (demo mode)

No configuration, no `.env`, nothing to decide:

```bash
git clone https://github.com/sockulags/clomp.git
cd clomp
docker compose -f docker-compose.demo.yml up -d
```

That's it. Open **http://localhost:8080** and log in as **`demo@clomp.local`**
with password **`clomp-demo`**. The demo starts pre-loaded with ~6 months of
realistic security activity, four scheduled controls (one deliberately
overdue) and a signed checkpoint — so the ledger, schedules, verify and
export views all have something to show immediately.

From there, hit **Verify** to recompute the whole hash chain, or grab the
JSONL export and check it offline with
`node backend/scripts/verify-export.js clomp-export.jsonl`.

> **DEMO MODE — not for production.** The database password and admin
> credentials are hardcoded and public. Tear it all down with
> `docker compose -f docker-compose.demo.yml down -v`, then follow the
> quick start below for a real installation.

## Quick start (Docker)

```bash
git clone https://github.com/sockulags/clomp.git
cd clomp

cp .env.example .env
# set POSTGRES_PASSWORD in .env to a strong value, e.g. from:
openssl rand -hex 16

# pulls prebuilt images from GHCR; use `docker compose up -d --build` to build locally
docker compose up -d

# create the first admin (also the break-glass recovery path)
docker compose exec backend node scripts/create-admin.js you@example.com "Your Name"
```

- Web UI: http://localhost:8080
- API: http://localhost:3001

## Recording events

From the UI (Record tab), or from code:

```js
const Clomp = require('@clomp/sdk-node'); // sdk-nodejs/

const clomp = new Clomp({
  apiUrl: 'http://localhost:3001',
  apiKey: process.env.CLOMP_API_KEY, // created by an admin in the UI
  defaultActor: { type: 'service', id: 'ci' }
});

clomp.record('patch.applied', { target: { type: 'system', id: 'web-01' } });
await clomp.destroy(); // flush before exit
```

Or from the shell — cron jobs, CI pipelines, runbooks (`npm i -g @clomp/sdk-node`):

```bash
CLOMP_API_KEY=clomp_live_... clomp record patch.applied --actor service:ci --target system:web-01
clomp verify                       # exit 1 if the chain is broken
clomp schedules --fail-on-overdue  # exit 1 if a scheduled control is overdue
```

Or plain REST:

```bash
curl -X POST http://localhost:3001/api/events \
  -H "X-API-Key: clomp_live_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"access.review.completed","actor":{"type":"user","id":"lucas"},"target":{"type":"scope","id":"all-prod"}}'
```

The action catalog is seeded with SOC 2- and NIS2-tagged activity types
(`access.review.*`, `patch.applied`, `incident.*`, `backup.tested`, …).
Custom actions are accepted and flagged in reports.

## Verifying

```bash
# online — recomputes the chain server-side
curl -H "X-API-Key: clomp_live_..." http://localhost:3001/api/verify
# => {"intact":true,"verified":5,"checkpoint":{"sequence":4,"signature_valid":true}}

# offline — what the auditor runs against an export, no server access needed
node backend/scripts/verify-export.js clomp-export.jsonl
```

Exports live in the UI (Export tab) or at `GET /api/export/jsonl` and
`GET /api/export/report` (PDF, mapped to SOC 2 criteria / NIS2 articles).

## Development

```bash
# a database
docker run -d --name clomp-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=clomp -e POSTGRES_DB=clomp -p 5432:5432 postgres:16-alpine

# backend (Express) — http://localhost:3000
cd backend && npm install
DATABASE_URL=postgresql://clomp:dev@localhost:5432/clomp npm run dev

# web UI (React + Vite) — http://localhost:5173, proxies /api to :3000
cd web-ui && npm install && npm run dev
```

Tests: `npm test` in `backend/` (Jest, includes hash-chain and RFC 6238
reference vectors), `web-ui/` (Vitest) and `sdk-nodejs/`. CI runs tests,
ESLint, Docker builds, CodeQL and Trivy.

## Security model, in one paragraph

clomp defends against *history being rewritten*: by an attacker with API
access, by an insider with database access, or by the operator themselves.
It does this with an append-only trigger, a per-tenant hash chain over
canonical JSON, signed checkpoints, and offline-verifiable exports. It does
not defend against events never being recorded — scheduled controls address
that by declaring the expected cadence and flagging overdue activities in
the UI and the PDF report. See [SECURITY.md](SECURITY.md) for reporting
vulnerabilities.

## License

MIT — see [LICENSE](LICENSE). Everything is free, including PDF reports and
future reminder features. No open-core, no paywalls.
