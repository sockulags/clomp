# Roadmap

Where clomp is going. No dates and no promises — items ship when they are
done and well-tested, and the order below can change based on what users
actually run into. Open a [GitHub
issue](https://github.com/sockulags/clomp/issues) if something here (or
missing here) matters to you; real deployment reports move things up.

## Where things stand

clomp is **alpha** (v0.2.x). What that means concretely:

- The core — append-only events, the hash chain, signed checkpoints,
  offline verification — is spec'd, tested against reference vectors, and
  exercised by an end-to-end tamper test in CI on every push. The [hash
  chain format](https://sockulags.github.io/clomp/reference/hash-chain) is
  considered stable.
- Pre-1.0, minor versions may contain breaking changes (schema, API,
  configuration). Read release notes before upgrading.
- The project has not had an external security audit. The [threat
  model](https://sockulags.github.io/clomp/reference/threat-model) is
  explicit about what is and is not defended against — read it before
  trusting clomp with anything important.

## Near term

In active development, roughly in order:

- **Versioned database migrations.** The schema is currently created with
  `CREATE TABLE IF NOT EXISTS` at startup; upgrades that alter existing
  tables need a real, ordered migration mechanism before 1.0.
- **Prometheus metrics.** A `/metrics` endpoint: event throughput, chain
  verification status, checkpoint age, overdue-control count — so the
  ledger's health can sit in the monitoring you already have.
- **API-key rotation.** Keys can be created and revoked today; first-class
  rotation (issue a successor, overlap window, retire the old key) is
  missing.
- **Multi-instance safety.** Nightly checkpoints, anchoring and digests
  run as in-process schedulers, which assumes a single backend instance.
  Locking/leader election so running two instances is safe.
- **Ledger search.** The event list filters on action, actor and time
  range; free-text search across actor, target and context is not there
  yet.
- **Python SDK.** REST works everywhere, but Python is where much of the
  security tooling that should write to clomp already lives.
- **Webhook delivery log.** Outgoing event webhooks and anchoring
  webhooks are fire-and-forget today; a visible delivery history with
  retries is needed for anchoring to be dependable.
- **Tenant management.** The schema is multi-tenant from day one, but
  there is no admin surface for creating and managing tenants —
  installations are effectively single-tenant.

## Mid term

Directions, less concrete:

- **A hosted option.** Self-hosted stays the primary mode and every
  feature stays free and MIT-licensed — no open-core, ever. But some
  teams want the ledger without operating it, and a managed (EU-hosted)
  offering is the natural service around the project.
- **More SDKs** (Go, and others as demand shows), generated from the
  OpenAPI specification where that produces good results.
- **Integrations that record for you** — pulling auditable events from
  identity providers, patch management and ticketing systems, so less of
  the trail depends on humans remembering.
- **i18n.** UI and docs are English-first; Swedish and other languages
  once the surfaces stabilize.

## Non-goals

Things clomp will not become, so you can rely on their absence:

- **No dashboards, no AI.** clomp is a ledger and a report. Boring on
  purpose.
- **No log collection.** Telemetry belongs in Loki/SigNoz/etc.; clomp is
  for deliberate, auditable events.
- **No paywalled features.** MIT, everything free, including whatever
  ships from this roadmap. See the
  [README](README.md#license) — this is a project decision, not a
  temporary one.
- **No edit-or-delete-an-event mechanism.** Requested occasionally,
  refused always — see [GDPR &
  personal data](https://sockulags.github.io/clomp/operations/gdpr) for
  how erasure works without one.
