# Users & authentication

## Roles

| Role | Ledger | Record | Schedules | Export | Admin |
|---|---|---|---|---|---|
| `admin` | ✔ | ✔ | manage | ✔ | users + API keys |
| `editor` | ✔ | ✔ | manage | ✔ | — |
| `auditor` | ✔ | ✘ | read | ✔ | — |

The `auditor` role exists so an external auditor can be given a real login
that can read and export — and nothing else.

**API keys** (`clomp_live_…`) are for machine writers: CI pipelines,
services, cron jobs. They are created by an admin, shown once, stored as
SHA-256 hashes, and revocable. An API key can record and read events but can
never manage users, keys or schedules.

### API key lifecycle

Auditors will ask how keys to the audit trail itself are rotated — clomp
gives each key a full lifecycle:

- **Expiry** — a key can be created with an optional `expires_at`. An
  expired key is rejected exactly like a revoked one. Keys without an
  expiry keep working forever (backwards compatible).
- **Usage tracking** — `last_used_at` is stamped when a key authenticates
  (throttled to once a minute per key), so you can see which keys are
  actually in use. The Admin view flags keys unused for 30+ days as
  **stale** — prime candidates for revocation.
- **Rotation** — `POST /api/keys/:id/rotate` (or the **rotate** button in
  the Admin view) atomically revokes the old key and issues a replacement
  with the same name. The new secret is shown once; the revoked key stays
  in the list for the audit trail. The API does not inherit the old key's
  expiry — set `expires_at` in the rotate body. The Admin view carries a
  still-valid expiry over to the replacement automatically.

## Passwords

- Hashed with **argon2id**.
- New users get a one-time initial password (shown once to the admin).
  Users change it under **Security → Change password**; changing it revokes
  every other session.
- Break-glass: `node scripts/create-admin.js <email>` against the database
  resets the password, disables TOTP and revokes sessions for that account.

## TOTP (two-factor)

RFC 6238, six digits, ±1 time step, timing-safe comparison — works with any
authenticator app. Enabling TOTP issues eight single-use recovery codes.
Re-configuring active TOTP requires the account password, so a hijacked
session cannot silently disarm it.

## Passkeys (WebAuthn)

Opt-in, because WebAuthn requires a secure context and a stable domain —
which intranet installs reached over plain IP don't have. Passwords + TOTP
remain the baseline that works everywhere.

```bash
# .env — enables the "Sign in with a passkey" button
WEBAUTHN_ORIGIN=https://clomp.example.com
# WEBAUTHN_RP_ID defaults to the origin's hostname
```

- A passkey login satisfies MFA on its own (user verification is built into
  the authenticator), so it bypasses the TOTP prompt.
- **Registering a passkey requires the account password** — a hijacked
  session must not be able to mint itself a durable credential.
- Login options never reveal whether an email exists (no user enumeration).
- Users manage their passkeys under **Security → Passkeys**.

## Sessions

256-bit random tokens stored hashed, delivered as `HttpOnly` +
`SameSite=Strict` cookies (add `Secure` via `COOKIE_SECURE=true`). Default
lifetime is 12 hours (`SESSION_TTL_HOURS`).

Users see every active session under **Security → Active sessions**
(browser, signed in, last active), can revoke any single one, and can
"sign out everywhere else". Changing the password revokes all other
sessions automatically.
