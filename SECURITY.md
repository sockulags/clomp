# Security Policy

## Reporting a Vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Do not open a public issue or disclose
before a fix is released. You can expect an acknowledgment within 48 hours
and an initial assessment within 7 days.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✔         |
| < 0.2   | ✘         |

## Threat model

clomp's core claim is **tamper-evidence**: recorded history cannot be
rewritten without detection. It is *not* confidentiality (the database is not
encrypted at rest) and it is *not* completeness (an event that was never
recorded is invisible — scheduled controls exist to surface that).

### What clomp defends against, and how

| Adversary | Attack | Defense |
|---|---|---|
| API client (valid key or editor login) | Alter or delete existing events | No update/delete API exists; the database trigger rejects `UPDATE`/`DELETE` on `events` for every role |
| Insider with the application's database credentials | Rewrite rows directly | Append-only trigger; if they own the table and disable the trigger, the hash chain breaks and `GET /api/verify` pinpoints the first altered sequence |
| Insider who rewrites rows **and** recomputes hashes | Re-hash the chain from the altered event forward | Ed25519-signed checkpoints: the re-hashed chain no longer matches the signed `(sequence, hash)` tips |
| Operator with root on the host (has the signing key) | Rewrite history and re-sign new checkpoints | **External anchoring** (`ANCHOR_EMAIL_TO` / `ANCHOR_WEBHOOK_URL`): checkpoints archived outside the server will not match the rewritten chain. Without anchoring configured, a root-level operator can rewrite history that predates the last export an auditor holds — configure anchoring |
| Anyone | Backdate activity invisibly | `occurred_at` and `recorded_at` are separate, both hashed; backfill is visible by design |
| Anyone | Swap an evidence file after the fact | Evidence is content-addressed; its SHA-256 is inside the hashed event |
| Retention / "we had to delete old data" | Use pruning as cover for erasing inconvenient history | Pruning cuts only at a signed checkpoint, archives the range first, and appends a `retention.pruned` event (with the archive's SHA-256) to the chain. Missing history without a matching checkpoint anchor fails verification — see [docs/retention.md](docs/retention.md) |

### Trust boundaries to understand before deploying

- **The application's Postgres role owns the schema** in the default
  docker-compose setup, so anyone holding `DATABASE_URL` credentials can
  disable the append-only trigger. They still cannot evade the hash chain or
  signed checkpoints — but for defense in depth, run
  `backend/scripts/harden-db-role.js` to create a non-owner role without
  `UPDATE`/`DELETE` on `events` and point the backend at it.
- **Checkpoint signing keys live on the server's disk** (`KEY_DIR`). An
  attacker with full host access can forge checkpoints from that moment on,
  but cannot rewrite history that predates the last externally anchored
  checkpoint or export. External anchoring is the mitigation that matters.
- **Exports contain everything** (events, context, evidence hashes). Treat
  export files and the auditor channel with the same care as the database.

## Authentication

- Passwords: argon2id. Users change their own password
  (`POST /api/auth/change-password`); changing it revokes all other sessions.
- TOTP (RFC 6238, timing-safe compare, ±1 step) with single-use recovery
  codes; re-configuring active TOTP requires the password. Admins can force a
  reset via `scripts/create-admin.js` (break-glass, DB access required).
- Passkeys (WebAuthn) are opt-in via `WEBAUTHN_ORIGIN` (needs HTTPS and a
  stable domain). A passkey login counts as MFA on its own; registering a
  new passkey requires the account password, so a hijacked session cannot
  mint itself a durable credential.
- Sessions: 256-bit random tokens stored hashed, `HttpOnly` +
  `SameSite=Strict` cookies (`COOKIE_SECURE=true` behind TLS).
- API keys: `clomp_live_` prefixed, stored as SHA-256 hashes, revocable.

## Deployment checklist

1. Strong `POSTGRES_PASSWORD`; never expose Postgres beyond loopback
   (the compose file binds `127.0.0.1` only).
2. Serve over HTTPS (reverse proxy) and set `COOKIE_SECURE=true`.
3. Restrict `ALLOWED_ORIGINS` to your exact domain — never `*`.
4. Configure **external anchoring** (`ANCHOR_EMAIL_TO` or
   `ANCHOR_WEBHOOK_URL`) — it is the difference between "tamper-evident
   against insiders" and "tamper-evident against everyone including root".
5. Back up the Postgres volume *and* `KEY_DIR` (checkpoint keypair) *and*
   the evidence directory; test restores (`backup.tested` is in the catalog
   for a reason).
6. Keep rate limits (`RATE_LIMIT_*`) at defaults or tighter.

## Tooling

- CI: tests, ESLint, CodeQL, Trivy container scanning, Dependabot.
- An end-to-end tamper test runs on every push: it corrupts a row in a real
  PostgreSQL and asserts that verification pinpoints the break and the
  offline verifier rejects the export (`backend/scripts/e2e.js`).
