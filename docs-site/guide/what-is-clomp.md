# What is clomp?

clomp is a self-hosted, append-only event log with a cryptographic hash chain.
It lets an organization **prove** — not just claim — that its security work
happens: access reviews, patching, incident handling, backup tests, training.

It is deliberately boring: no dashboards, no AI. Just a ledger that cannot be
rewritten, and a report that holds up in an audit. The boringness *is* the
value.

## Who it is for

- **Security officers / CISOs** who today assemble Excel sheets and Word
  documents before every audit. clomp replaces that with a ledger people and
  systems write to continuously, and a PDF that is generated in one click.
- **Development teams in B2B products** whose customers demand an audit
  trail. The same core is an API: typed events over REST or the Node SDK.
- **Public sector and regulated organizations** that cannot ship data to a
  US SaaS. clomp is self-hosted, open source (MIT) and PostgreSQL-only.

## Why it holds up in an audit

The reason an auditor can trust a clomp export more than a spreadsheet:

1. **Append-only at the database level.** A trigger rejects `UPDATE` and
   `DELETE` on events for every role, superuser included.
2. **Tamper-evident.** Each event embeds the hash of its predecessor. Change
   one byte anywhere and verification pinpoints the first broken sequence.
3. **Backfill is visible, not hidden.** `occurred_at` (when it happened) and
   `recorded_at` (when it was logged) are both first-class and both hashed.
   Late entries are allowed and *visible* — exactly what an auditor wants.
4. **Evidence with teeth.** Uploaded files are content-addressed by SHA-256
   and the hash is part of the event.
5. **Verifiable without trusting the server.** Exports verify offline, and
   nightly Ed25519-signed checkpoints can be anchored externally.

## What clomp does not do

- It does not **collect** logs (use Loki, SigNoz or similar for telemetry —
  clomp is for deliberate, auditable events).
- It does not provide **confidentiality**: the database is not encrypted at
  rest. The chain detects tampering; it does not hide data.
- It cannot know about events that were **never recorded** — that is what
  [scheduled controls](/guide/scheduled-controls) address.

## What it looks like

The ledger — every event chained, the header always showing chain status:

![The clomp ledger](/ledger.png)

Scheduled controls — the declared cadence, and what is overdue:

![Scheduled controls](/schedules.png)

The PDF the auditor gets:
[sample report](https://github.com/sockulags/clomp/blob/main/docs/sample-report.pdf).

## The two tracks

| | Track 1: Audit-trail API | Track 2: The security logbook |
|---|---|---|
| User | Development teams in B2B apps | Security officer / CISO |
| Usage | The app logs typed events via API/SDK | People log security activities in the UI |
| Example | "user X changed permission Y" | "Q3 access review completed, evidence attached" |
| Driver | Customer requirements for an audit trail | Audits / NIS2 supervision |

Both tracks share the same core: append-only events with actor/action/target,
the hash chain, retention and export.
