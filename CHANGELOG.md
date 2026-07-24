# Changelog

All notable changes to clomp. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver
(pre-1.0: minor bumps may contain breaking changes).

## [Unreleased]

### Security
- **`/metrics` now requires a token by default.** `METRICS_ENABLED=true`
  without `METRICS_TOKEN` used to serve the full registry — tenant ids,
  ingestion rates, checkpoint ages — to anyone who could reach the port.
  The route is now left unmounted in that case (`/metrics` answers 404) and
  the backend logs an error naming what to set. Nothing else is affected:
  the server still starts, still records events, and the in-memory counters
  keep updating — an audit trail must not go down because its telemetry is
  misconfigured.

  **Migration**: if you enabled metrics without a token, either set
  `METRICS_TOKEN` (`openssl rand -hex 32`) and give your scraper the bearer
  token, or set `METRICS_ALLOW_UNAUTHENTICATED=true` to keep the previous
  unauthenticated behaviour on a trusted network — that logs a warning at
  startup. Installs that already set `METRICS_TOKEN` are unaffected.
- **Evidence files are now scoped per tenant.** `evidence_files` was keyed on
  the sha256 alone and `GET /api/evidence/:sha256` only required
  authentication, so with `MULTI_TENANT=true` any authenticated principal of
  one tenant could download another tenant's evidence if they knew its hash —
  and because storage is deduplicated globally, the stored filename and
  uploader were the first uploader's across the tenant boundary. Downloads are
  now scoped to the requesting tenant (a foreign hash returns 404, never 403,
  so the endpoint cannot confirm that someone else's file exists) and metadata
  rows are per tenant. The bytes stay content-addressed in one copy on disk, so
  anything that deletes evidence must count referencing rows, not files.

  Migration `004_evidence_tenant_scope.sql` backfills ownership from the events
  that reference each hash. On a single-tenant install — every install today,
  since multi-tenant mode is opt-in — files that no event references are
  assigned to that one tenant. On a multi-tenant install they are parked in
  `evidence_files_unclaimed` with a warning instead of being guessed at, and
  need attributing by hand before they can be downloaded again.
- **Guard against the next one**: `tenant-scoping.test.js` fails the build when
  a SQL statement touches a tenant-owned table without constraining
  `tenant_id`. Exemptions require a written reason. This test fails on the
  evidence code as it was shipped.

### Added
- **API key lifecycle**: optional `expires_at` at creation (an expired key
  is rejected like a revoked one; existing keys keep working),
  `last_used_at` usage tracking (throttled to one write per key per
  minute), and atomic rotation (`POST /api/keys/:id/rotate`) that revokes
  the old key and returns the replacement secret once. The Admin view
  shows expiry, last-used and a stale flag for keys unused for 30+ days.

### Changed
- **BREAKING — the server now requires Node.js 24.** The backend and web-ui
  images build on `node:24-alpine` and CI runs Node 24. The published images
  are self-contained, so this only bites if you run the backend on your own
  Node: anything older than 24 has to upgrade. Node 20 went out of active
  support, and staying on it was blocking dependency updates that had
  already moved past it.

  `@clomp/sdk-node` deliberately keeps `engines: { node: ">=18" }`. It is a
  plain HTTP client with no native dependencies, and the server's runtime
  requirement is not the embedding application's — demanding Node 24 from
  every consumer of the client would be a breaking change with no technical
  driver behind it.

  **Migration**: upgrade the host Node to 24+ before taking this release.
  Nothing in the API, the database schema, the chain format, the export
  format or the SDK contract changes.
- `argon2` 0.44 → 0.45.1 (password hashing). 0.45 was held back because it
  publishes no musl prebuild for Node 20; on Node 24 the musl prebuild is
  used directly, with no node-gyp compile in the image.
- Web UI test stack: `@testing-library/jest-dom` 6 → 7 and
  `@testing-library/react` 16.3.1 → 16.3.2. jest-dom 7 requires Node 22+
  and makes `@testing-library/dom` a real peer dependency, so it is now
  declared explicitly in `web-ui/package.json` instead of being hoisted in
  from `@testing-library/react`.

### Security
- Pinned `brace-expansion` to 5.0.8 through an override in `backend/`
  (GHSA-mh99-v99m-4gvg, DoS, high). Every version up to 5.0.7 is affected
  and the fix only exists in 5.0.8, while the transitive ranges under the
  jest and eslint toolchains ask for `^1.1.11` / `^2.0.1` — so an override
  is the only route, and `npm audit fix` would instead downgrade
  `babel-jest` by five majors. Dev-only dependency, no production path, but
  the audit gate is a real gate now and it should stay readable.

## [0.2.0-alpha] — 2026-07-15

### Added
- **Scheduled controls**: declare how often an activity must be logged;
  overdue status in the UI, the PDF report and the CLI
  (`clomp schedules --fail-on-overdue`). Schedule changes are chain events.
- **External checkpoint anchoring** (opt-in): nightly signed checkpoints
  delivered via email (`ANCHOR_EMAIL_TO`) and/or webhook
  (`ANCHOR_WEBHOOK_URL`).
- **Retention pruning** that preserves chain verifiability: cuts only at a
  signed checkpoint, archives to verifiable JSONL first, records
  `retention.pruned` on the chain (`backend/scripts/retention-prune.js`).
- **`clomp` CLI** in `@clomp/sdk-node` (published to npm): `record` with
  evidence upload, `verify` and `schedules` with cron-friendly exit codes,
  `export`, `catalog`.
- **Passkeys (WebAuthn)** as an opt-in second auth path
  (`WEBAUTHN_ORIGIN`); registration requires the account password.
- **Password change** (`POST /api/auth/change-password`) — revokes all
  other sessions.
- **E2E tamper test in CI** against real PostgreSQL: record → checkpoint →
  prune → export → offline verify → tamper → verify pinpoints the break.
- **Documentation site**: <https://sockulags.github.io/clomp/>, with an
  OpenAPI 3.1 specification.
- **Offline CLI verification**: `clomp verify-file` (dependency-free chain
  verification) and `clomp anchor-check` (compare an archived anchoring
  checkpoint against an export — detects post-anchor history rewrites).
- **Overdue-control email digest** (`NOTIFY_EMAIL_TO`): daily reminder when
  scheduled controls slip; silent on green days.
- **Outgoing event webhooks** (`EVENT_WEBHOOK_URL`): every appended event
  POSTed as JSON, with action-prefix filtering.
- **Session management**: active-sessions view with per-session revoke and
  "sign out everywhere else"; sessions record user agent and last activity.
- **Restricted database role** (`scripts/harden-db-role.js`): run the app
  without UPDATE/DELETE on events or the ability to disable triggers.
- **GitHub Action** (`sockulags/clomp/.github/actions/record@main`) for
  recording audit events from CI.
- **Report configuration**: `REPORT_ORG_NAME` title line and
  `?framework=soc2|nis2` filter.
- Per-API-key rate limiting on event ingestion (previously per-IP only).
- SBOM and SLSA provenance attestations on released Docker images.
- Demo seed script, sample PDF report, UI screenshots; issue templates.

### Fixed
- Backend logs now report the real package version (previously hardcoded
  fallback `1.0.0` outside npm scripts).

### Changed
- Chain verification anchors retention-pruned history at the matching
  signed checkpoint and reports `anchored_at`.
- Re-configuring active TOTP requires the account password.
- Strict CSP: `script-src 'self'` (no `unsafe-inline`).
- SECURITY.md rewritten with a concrete threat model.

## [0.1.0-alpha] — 2026-07-14

First public alpha, after the pivot from generic log collection
(loggservice) to a tamper-evident audit trail (clomp).

### Added
- Append-only `events` table with per-tenant SHA-256 hash chain and
  database-level UPDATE/DELETE rejection.
- Ed25519-signed nightly checkpoints; `GET /api/verify` recomputes the
  chain and pinpoints the first break.
- Offline verifier (`backend/scripts/verify-export.js`) for JSONL exports.
- Audit-ready PDF report mapped to SOC 2 criteria / NIS2 articles.
- Content-addressed evidence uploads (SHA-256 inside the hashed event).
- Users with roles (`admin`/`editor`/`auditor`), argon2id passwords, TOTP
  with recovery codes; hashed API keys for machine writers.
- Node SDK rewritten for the events model.
- Docker Compose deployment; images on GHCR.
