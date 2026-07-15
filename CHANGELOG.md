# Changelog

All notable changes to clomp. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver
(pre-1.0: minor bumps may contain breaking changes).

## [Unreleased]

### Added
- Per-API-key rate limiting on event ingestion (previously per-IP only).
- SBOM and SLSA provenance attestations on released Docker images.
- Issue templates and repository metadata.

### Fixed
- Backend logs now report the real package version (previously hardcoded
  fallback `1.0.0` outside npm scripts).

## [0.2.0-alpha] — pending

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
- **Documentation site**: <https://sockulags.github.io/clomp/>.
- Demo seed script, sample PDF report, UI screenshots.

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
