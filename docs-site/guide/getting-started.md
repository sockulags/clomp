# Getting started

## Try it in 2 minutes (demo mode)

The fastest way to see clomp working — no configuration, no `.env`:

```bash
git clone https://github.com/sockulags/clomp.git
cd clomp
docker compose -f docker-compose.demo.yml up -d
```

Open <http://localhost:8080> and log in:

| | |
|---|---|
| Email | `demo@clomp.local` |
| Password | `clomp-demo` |

The demo bootstraps itself on first start: it creates the demo admin and
seeds ~6 months of realistic security activity, four scheduled controls
(one deliberately overdue) and a signed checkpoint. Ledger, Schedules,
Verify and Export all have data from the first second.

::: danger DEMO MODE — not for production
The Postgres password and admin credentials in `docker-compose.demo.yml`
are hardcoded and public by design. Never expose a demo instance beyond
your own machine. Tear it down with
`docker compose -f docker-compose.demo.yml down -v` and follow the
quick start below for a real installation.
:::

## Quick start with Docker

Prebuilt images are published to GHCR on every release.

```bash
git clone https://github.com/sockulags/clomp.git
cd clomp

cp .env.example .env
# set POSTGRES_PASSWORD in .env to a strong value, e.g. from:
openssl rand -hex 16

docker compose up -d

# create the first admin (also the break-glass recovery path)
docker compose exec backend node scripts/create-admin.js you@example.com "Your Name"
```

- Web UI: <http://localhost:8080>
- API: <http://localhost:3001>

The one-time password is printed to the terminal. Sign in, change it under
**Security → Change password**, and enable TOTP.

::: tip Try it with demo data
`docker compose exec backend node scripts/seed-demo.js` seeds ~6 months of
realistic activity, four scheduled controls (one deliberately overdue) and a
signed checkpoint. It refuses to run if the chain already has events.
:::

## First steps

1. **Record something.** Open the **Record** tab and log an activity — say,
   a completed access review — or do it from the shell:

   ```bash
   curl -X POST http://localhost:3001/api/events \
     -H "X-API-Key: clomp_live_..." \
     -H "Content-Type: application/json" \
     -d '{"action":"access.review.completed","actor":{"type":"user","id":"lucas"},"target":{"type":"scope","id":"all-prod"}}'
   ```

2. **Declare your cadence.** In **Schedules**, add the controls your
   framework expects: access reviews quarterly, restore tests monthly,
   training yearly. Overdue controls are flagged in the UI and in reports.

3. **Verify the chain.**

   ```bash
   curl -H "X-API-Key: clomp_live_..." http://localhost:3001/api/verify
   # => {"intact":true,"verified":5,"checkpoint":{"sequence":4,"signature_valid":true}}
   ```

4. **Configure external anchoring** (strongly recommended) — see
   [External anchoring](/operations/anchoring). It is the difference between
   "tamper-evident against insiders" and "tamper-evident against everyone,
   including root".

## Development setup

Requires **Node.js 24+** — the same version the Docker images and CI run.

```bash
# a database
docker run -d --name clomp-pg -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_USER=clomp -e POSTGRES_DB=clomp -p 5432:5432 postgres:16-alpine

# backend (Express) — http://localhost:3000
cd backend && npm install
DATABASE_URL=postgresql://clomp:dev@localhost:5432/clomp npm run dev

# web UI (React + Vite) — http://localhost:5173, proxies /api to :3000
cd web-ui && npm install && npm run dev
```

Tests: `npm test` in `backend/` (Jest, includes hash-chain and RFC 6238
reference vectors), `web-ui/` (Vitest) and `sdk-nodejs/`. CI additionally
runs an end-to-end tamper test against a real PostgreSQL on every push.
