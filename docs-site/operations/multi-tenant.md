# Multi-tenant mode

clomp's schema has been multi-tenant from day one: every event, checkpoint,
user, API key and schedule carries a `tenant_id`, and each tenant has its own
independent hash chain with its own sequence numbers, checkpoints and
advisory locks. By default, though, an installation runs **single-tenant** —
one `default` tenant is created at first start and everything belongs to it.

Setting `MULTI_TENANT=true` unlocks the first slice of multi-tenant
operation: managing several isolated tenants on one installation.

## Who this is for

The typical user is an **MSP or security consultant** who runs compliance
work for several client organizations. Instead of one clomp installation per
client, you run one installation with one tenant per client:

- Each client gets its **own hash chain** — sequences start at 1, checkpoints
  are signed per tenant, and `GET /api/verify` verifies each chain
  independently. One client's export never contains another client's events.
- Each client gets its **own users and API keys**. A user or key belongs to
  exactly one tenant and can only ever read and write that tenant's data.
- Deactivating a lapsed client is **soft**: the chain is append-only, so the
  tenant's history stays in the database and remains verifiable, but its
  users can no longer sign in and its API keys stop resolving.

## Enabling it

```bash
# .env
MULTI_TENANT=true
```

With the flag **off** (the default), the service behaves exactly as a
single-tenant install always has — the `/api/tenants` endpoints respond
`404` and nothing else changes. The flag can be turned on later without any
migration: the schema is already tenant-scoped.

## Managing tenants

Tenant management is **restricted to admins of the operator tenant** — the
tenant created at first start (`TENANT_NAME`, `default` unless changed) —
and session-only (API keys cannot manage the roster). Admins of client
tenants manage their own users, keys and events, but never see other
tenants: they get `403` from every `/api/tenants` endpoint. Tenants are
identified by an immutable slug (lowercase letters, digits, hyphens) plus a
display name you can change.

```bash
# List all tenants (active and deactivated)
curl -b cookies.txt http://localhost:3001/api/tenants

# Create a tenant
curl -b cookies.txt -X POST http://localhost:3001/api/tenants \
  -H 'Content-Type: application/json' \
  -d '{"slug": "acme", "display_name": "Acme Corp"}'

# Rename (display name only — the slug is the stable identifier)
curl -b cookies.txt -X PATCH http://localhost:3001/api/tenants/<id> \
  -H 'Content-Type: application/json' \
  -d '{"display_name": "Acme Corporation"}'

# Soft-deactivate (no hard delete; history stays verifiable)
curl -b cookies.txt -X DELETE http://localhost:3001/api/tenants/<id>

# Reactivate
curl -b cookies.txt -X POST http://localhost:3001/api/tenants/<id>/activate
```

You cannot deactivate your own tenant — that would lock out the acting
admin. Every tenant lifecycle change (`tenant.created`, `tenant.renamed`,
`tenant.deactivated`, `tenant.reactivated`) is itself recorded as an event
on the **acting admin's** chain, so the roster history is tamper-evident
like everything else.

## Bootstrapping a tenant's first admin

Creating a tenant via the API creates an empty organization. Its first
admin is created with the break-glass script:

```bash
node backend/scripts/create-admin.js admin@acme.example "Acme Admin" --tenant acme
```

`--tenant <slug>` creates the tenant if it does not exist yet, so you can
also bootstrap entirely from the CLI — and if the targeted tenant was
soft-deactivated, the script reactivates it (it is the break-glass path; a
printed one-time password must actually work). Without `--tenant`, the
script targets the default tenant exactly as before. Note that email
addresses are unique per installation, not per tenant.

From there the tenant's admin signs in, changes the one-time password,
enables TOTP, creates the tenant's own API keys under **Settings → API
keys**, and records events as usual — all scoped to their tenant.

## Isolation model

Tenant scoping is enforced server-side on every query:

- A session or API key resolves to exactly one `tenant_id`; every read and
  write (`/api/events`, `/api/verify`, `/api/export`, `/api/schedules`,
  `/api/keys`, `/api/users`) is filtered by it. There is no request
  parameter to select another tenant.
- Chains cannot interleave: appends take a per-tenant advisory lock, and
  `(tenant_id, sequence)` is unique.
- Users and API keys created by a tenant's admin are always created in that
  admin's own tenant; there is no way to provision into another tenant.
- Deactivated tenants are enforced at the door: session resolution,
  password login, passkey login and API-key resolution all require the
  tenant to be active.

## First-slice limitations

This is deliberately a first slice. Not included yet:

- **No tenant switcher in the web UI** — an admin session belongs to one
  tenant; manage the roster via the API or `curl`.
- **No per-tenant self-signup** — tenant admins are bootstrapped with
  `create-admin.js`.
- **Shared configuration** — checkpoint schedule, retention, anchoring and
  webhooks are installation-wide, not per tenant.
- **One checkpoint signing key** for the whole installation (checkpoints are
  still signed per tenant chain).
