# REST API

Base URL: your installation, e.g. `https://clomp.example.com`. All request
and response bodies are JSON unless noted.

A machine-readable [OpenAPI 3.1 specification](/openapi.yaml) is available
for client generation and API tooling.

## Authentication

Two credential types, resolved per request:

- **API key** — header `X-API-Key: clomp_live_…`. Machine writers/readers,
  scoped to their tenant. Cannot manage users, keys or schedules.
- **Session cookie** — `clomp_session`, obtained via `POST /api/auth/login`.
  Role-gated (`admin` / `editor` / `auditor`).

## Events

### `POST /api/events`

Append an event to the chain. Auth: API key, or session `admin`/`editor`.

```json
{
  "action": "access.review.completed",
  "actor": { "type": "user", "id": "lucas" },
  "target": { "type": "scope", "id": "all-prod" },
  "context": { "reviewed_accounts": 44 },
  "evidence": [{ "filename": "review.pdf", "sha256": "9f2c…", "size": 482133 }],
  "occurred_at": "2026-07-07T09:00:00Z"
}
```

- `action` — required; namespaced lowercase (`^[a-z0-9_]+(\.[a-z0-9_]+)+$`), ≤ 200 chars.
- `actor` — required; object with at least `type` and `id`. The server adds
  `actor.recorded_by` (session user or API key) — not spoofable.
- `occurred_at` — optional; ISO 8601, at most 1 hour in the future.
- `actor`/`target`/`context`/`evidence` — each ≤ 32 KB of JSON.
- `evidence` — optional array; every item needs a 64-char hex `sha256`.

**201** → `{ "event": { …, "sequence": 1285, "hash": "…" }, "known_action": true }`

### `GET /api/events`

List with filters and keyset pagination. Auth: any.

Query: `action`, `actor_id`, `from`, `to` (ISO timestamps, on `occurred_at`),
`before_sequence`, `limit` (1–500, default 50).

**200** → `{ "events": […], "has_more": true, "next_before_sequence": 1235 }`

### `GET /api/events/:sequence`

One event by chain position. **404** if absent.

### `GET /api/events/catalog`

The seeded [action catalog](/reference/action-catalog) with SOC 2 / NIS2 tags.

## Verification

### `GET /api/verify?from=&to=`

Recompute the hash chain over an optional sequence range. Auth: any.

**200** → `{ "intact": true, "verified": 1284, "checkpoint": { "sequence": 1280, "signed_at": "…", "signature_valid": true } }`

Broken chains return `intact: false` with `firstBreak` and `reason`;
retention-pruned chains include `anchored_at`. See
[Verification](/guide/verification).

## Evidence

### `POST /api/evidence`

`multipart/form-data` with a single `file` field (≤ 25 MB by default).
Auth: API key, or session `admin`/`editor`.

**201** → `{ "sha256": "9f2c…", "filename": "review.pdf", "size": 482133 }`

### `GET /api/evidence/:sha256`

Download by content hash. Auth: any (auditors included).

## Export

### `GET /api/export/jsonl?from=&to=`

Offline-verifiable JSONL (events + signed checkpoints). Auth: any.

### `GET /api/export/report?from=&to=&framework=`

Audit-ready PDF. Auth: any. `framework=soc2|nis2` limits the framework
mappings to one framework; `REPORT_ORG_NAME` prints your organization name
in the title block. See [Exports & reports](/guide/exports).

## Schedules

### `GET /api/schedules`

All scheduled controls with computed status. Auth: any.

**200** → `{ "schedules": [{ "action": "access.review.completed", "frequency": "quarterly", "grace_days": 14, "status": "ok", "last_event_at": "…", "next_due_at": "…", … }], "overdue": 0 }`

### `POST /api/schedules`

Create. Auth: session `admin`/`editor` (never API keys). Body: `action`
(namespaced), `frequency` (`daily|weekly|monthly|quarterly|yearly`),
optional `title` (≤ 200 chars), `grace_days` (0–365). One schedule per
action; duplicates → **409**. Appends `control.schedule.created` to the chain.

### `PATCH /api/schedules/:id`

Update `title`, `frequency`, `grace_days` and/or `active`. Auth: session
`admin`/`editor`. Appends `control.schedule.updated`.

### `DELETE /api/schedules/:id`

Remove. Auth: session `admin`. Appends `control.schedule.removed`.

## Auth & account

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/auth/login` | — | `{ email, password, totp? }`; sets the session cookie. `401` with `totp_required: true` when a code is needed |
| `POST /api/auth/logout` | session | Destroys the session |
| `GET /api/auth/me` | session | The signed-in user |
| `POST /api/auth/change-password` | session | `{ current_password, new_password }` (10–200 chars); revokes all other sessions |
| `GET /api/auth/sessions` | session | Active sessions (user agent, created, last active, `current` flag) |
| `DELETE /api/auth/sessions/:id` | session | Revoke one of your own sessions |
| `POST /api/auth/sessions/revoke-others` | session | Sign out everywhere else |
| `POST /api/auth/totp/setup` | session | Returns secret + `otpauth://` URL; requires `{ password }` if TOTP is already enabled |
| `POST /api/auth/totp/enable` | session | `{ code }`; returns 8 single-use recovery codes |
| `POST /api/auth/totp/disable` | session | `{ password }` |

### Passkeys (WebAuthn)

Enabled only when `WEBAUTHN_ORIGIN` is configured; otherwise ceremonies
return **501**.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/auth/passkeys/config` | — | `{ enabled }` |
| `GET /api/auth/passkeys` | session | The user's registered passkeys |
| `POST /api/auth/passkeys/register/options` | session | Requires `{ password }`; returns WebAuthn options + `challenge_id` |
| `POST /api/auth/passkeys/register/verify` | session | `{ challenge_id, response, name? }` |
| `DELETE /api/auth/passkeys/:id` | session | Remove own passkey |
| `POST /api/auth/passkeys/login/options` | — | `{ email? }`; never reveals whether an email exists |
| `POST /api/auth/passkeys/login/verify` | — | `{ challenge_id, response }`; sets the session cookie |

## Admin

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/users` | admin | |
| `POST /api/users` | admin | `{ email, name, role }`; returns a one-time `initial_password` |
| `PATCH /api/users/:id` | admin | `{ role?, disabled? }`; you cannot disable or demote yourself |
| `POST /api/users/:id/reset-password` | admin | New one-time password; clears TOTP, revokes sessions |
| `GET /api/keys` | admin | Includes `expires_at` and `last_used_at` per key |
| `POST /api/keys` | admin | `{ name, expires_at? }`; the full key is returned exactly once |
| `POST /api/keys/:id/rotate` | admin | `{ expires_at? }`; atomically revokes the key and creates a replacement with the same name — the new secret is returned exactly once |
| `DELETE /api/keys/:id` | admin | Revoke |

API key lifecycle notes:

- `expires_at` (optional, ISO 8601, must be in the future) makes a key stop
  authenticating at that instant — an expired key is rejected exactly like a
  revoked one. Existing keys without an expiry keep working.
- `last_used_at` records when the key last authenticated, throttled to at most
  one write per key per minute (so it can lag by up to a minute).
- Rotation does not inherit the old key's expiry: pass `expires_at` in the
  rotate body, or omit it for a non-expiring replacement. (The web UI passes
  the old key's still-future expiry along automatically.)

## Health

`GET /health` → `{ "status": "ok", "database": "connected", … }` (no auth;
rate-limited separately).

## Rate limits

Per-IP, configurable via `RATE_LIMIT_*`: 300 req/min general, 1000 req/min
for event ingestion, 10 login attempts/min.
