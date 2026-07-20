# Deployment

## Docker Compose (recommended)

The repository's `docker-compose.yml` runs three containers: PostgreSQL 16,
the backend (Express) and the web UI (nginx). Prebuilt images are pulled
from GHCR; `docker compose up -d --build` builds locally instead.

```bash
cp .env.example .env       # set POSTGRES_PASSWORD
docker compose up -d
docker compose exec backend node scripts/create-admin.js you@example.com "Your Name"
```

Postgres is bound to `127.0.0.1` only — the containers talk over the compose
network, and the host mapping exists solely for local inspection.

## Production checklist

1. **TLS.** Put a reverse proxy (Caddy, nginx, Traefik) in front and set
   `COOKIE_SECURE=true`.
2. **CORS.** Set `ALLOWED_ORIGINS` to your exact origin — never `*`.
3. **External anchoring.** Set `ANCHOR_EMAIL_TO` or `ANCHOR_WEBHOOK_URL` —
   see [External anchoring](/operations/anchoring). This is the single most
   important hardening step.
4. **Backups.** Postgres volume + `KEY_DIR` (checkpoint signing keypair) +
   evidence directory. Test restores — see [Backup & restore](/operations/backup).
5. **Passkeys** (optional). On an HTTPS install with a stable domain, set
   `WEBAUTHN_ORIGIN` — see [Users & authentication](/operations/authentication).
6. **Rate limits.** The defaults (`RATE_LIMIT_*`) are sane; tighten rather
   than loosen.
7. **Overdue reminders & webhooks** (optional). `NOTIFY_EMAIL_TO` mails a
   daily digest when scheduled controls slip; `EVENT_WEBHOOK_URL` forwards
   events to Slack relays or a SIEM — see [Integrations](/operations/integrations).
8. **Defense in depth** (optional). The default setup lets the application's
   database role own the schema. Create a restricted role instead:

   ```bash
   DATABASE_URL=postgresql://clomp:owner-pw@host/clomp \
     node backend/scripts/harden-db-role.js --role clomp_app --password 'strong-pw'
   ```

   The new role runs the app but cannot `UPDATE`/`DELETE` events or disable
   the append-only trigger. Keep the owning role for schema upgrades and
   [retention](/operations/retention); re-run the script after upgrades.

All configuration is environment variables — see the
[configuration reference](/reference/configuration).

## Horizontal scaling

A single instance is the common case and needs none of this. If you do run
several backend replicas against the same PostgreSQL database (for
availability or rolling deploys), here is what to expect:

- **Scheduled jobs are single-runner.** Every replica starts the cron
  scheduler, but each run of a scheduled job (checkpoint signing — including
  external anchoring — and overdue-control notifications) first takes a
  PostgreSQL advisory lock (`pg_try_advisory_lock`). Replicas that do not win
  the lock skip that run, so a schedule tick produces exactly one checkpoint
  per tenant and one notification digest, no matter how many replicas are
  running. No configuration is required. One caveat: these are session-level
  locks, so the backend must talk to PostgreSQL directly or through a pooler
  in *session* mode — a transaction-mode pooler (e.g. PgBouncer in
  `pool_mode = transaction`) breaks session advisory locks and voids the
  single-runner guarantee.
- **Event appends are already safe.** Each append runs in a transaction
  holding a per-tenant advisory lock, so concurrent writes through any number
  of replicas produce a gap-free, fork-free chain.
- **Rate limiting is per process.** The `express-rate-limit` counters live in
  each replica's memory, so N replicas behind a load balancer collectively
  allow up to N × `RATE_LIMIT_MAX` requests per window per client (and
  likewise for the other `RATE_LIMIT_*` ceilings). Compensate at the load
  balancer — e.g. nginx `limit_req` or HAProxy stick tables — or divide the
  `RATE_LIMIT_*` values by the replica count.

## Sizing

Audit volumes are small. Events are single-row inserts with a per-tenant
advisory lock; a modest VM with a few GB of disk carries years of activity
for most organizations. The chain is verified in streaming batches, so
verification memory stays flat regardless of history size.

## Upgrades

```bash
docker compose pull && docker compose up -d
```

The schema is created idempotently at startup (`CREATE TABLE IF NOT
EXISTS`); new tables and triggers appear automatically. The events table is
append-only, so upgrades never rewrite history.
