# How clomp compares

clomp does one thing: a tamper-evident ledger of security activities, with
exports an auditor can verify independently. The tools people compare it
to mostly do *other* things, some of which clomp deliberately does not do.
This page is meant to help you pick the right tool — including when that
is not clomp.

## At a glance

| | clomp | Compliance platforms (Vanta, Drata, …) | Cloud audit logs (CloudTrail, Datadog Audit Trail, …) | A database table |
|---|---|---|---|---|
| What it is | Tamper-evident ledger for security work | Full compliance-automation suite | Activity log of one platform's own API/service | Whatever you build |
| Hosting | Self-hosted (your infra, EU/on-prem OK) | SaaS | Part of the cloud platform | Yours |
| Tamper evidence | Hash chain + signed checkpoints, DB-level append-only | Trust in the vendor | Varies; scoped to the platform's own trust model | None unless you build it |
| Independent verification | Offline, by the auditor, without server access | No | Generally within the platform | No |
| Evidence collection | You record events (UI, API, CLI, CI) | Largely automated via integrations | Automatic, but only that platform's events | You build it |
| Compliance workflow (policies, tasks, auditor portal) | No — a ledger and a PDF report | Yes, extensive | No | No |
| License / cost | MIT, free, all features | Commercial subscription | Bundled with / priced by the platform | "Free" plus your time |
| Maturity | **Alpha** | Established products | Established products | Depends on you |

## vs. compliance-automation platforms

Platforms like Vanta and Drata are much bigger products than clomp: they
connect to your cloud accounts and SaaS tools, collect evidence
automatically, track policies and tasks, monitor controls continuously and
manage the auditor relationship. If you want a guided path to a SOC 2
report with minimal manual effort, and a US SaaS holding your compliance
data is acceptable to you, they do far more than clomp does — clomp does
not automate evidence collection and has no policy or workflow features.

What clomp offers that category structurally does not:

- **Self-hosted.** The record of your security work never leaves your
  infrastructure. For public sector, defense-adjacent and other
  data-residency-constrained organizations — a large part of who NIS2
  covers — this is often not a preference but a requirement.
- **Cryptographic verifiability.** A clomp export proves itself: hash
  chain, signed checkpoints, offline verifier. The auditor does not have
  to trust you *or* a platform vendor.
- **MIT-licensed, free, no per-seat pricing.** Every feature, including
  reports, for every user. A municipality or a five-person team pays
  nothing and needs no procurement cycle to try it.
- **A small, inspectable surface.** One Express backend, one PostgreSQL
  database, a [spec'd hash chain](/reference/hash-chain) with published
  test vectors and a [concrete threat model](/reference/threat-model).

They are not mutually exclusive: some teams keep a platform for workflow
and use clomp as the verifiable system of record underneath.

## vs. cloud audit logs

AWS CloudTrail records API activity in your AWS account; Datadog Audit
Trail records what users do inside Datadog. Both are good at what they do,
and clomp does not replace either — clomp will never automatically know
that someone changed an S3 bucket policy.

The differences are scope and trust model:

- **Scope.** A platform audit log covers that platform. clomp is
  cross-system and includes the things no cloud can observe: the access
  review that happened in a meeting, the restore test, the tabletop
  exercise, the training session. Audits are about your *organization's*
  activities, not one vendor's API calls.
- **Trust model.** A platform's audit log lives inside that platform's
  trust boundary. clomp's verification is designed to work *against* its
  own operator: append-only at the database level, externally anchorable
  checkpoints, exports that verify on the auditor's laptop.
- **Deliberate vs. exhaustive.** Cloud logs capture everything, and the
  signal drowns. clomp events are recorded on purpose, mapped to SOC 2
  criteria and NIS2 articles, and the [action
  catalog](/reference/action-catalog) is the vocabulary of an audit.

A reasonable architecture: let CloudTrail be CloudTrail, and record the
audit-relevant conclusions ("quarterly IAM review completed, findings
attached") into clomp — with the CloudTrail excerpt as content-addressed
evidence.

## vs. a database table

The honest competitor. Most home-grown audit trails are an `audit_log`
table (or a spreadsheet), and if nobody will ever challenge the record,
that may genuinely be enough.

The problem is that a table proves nothing. Anyone with credentials — a
developer, a DBA, an attacker, you — can `UPDATE` a row, and the row
looks exactly like it always did. When an auditor, a court or a
supervisory authority asks "how do I know this wasn't edited after the
fact?", the answer is "trust us."

clomp is what the table becomes once you take that question seriously:
append-only enforced by a trigger for every role, each event chained to
its predecessor by SHA-256, nightly Ed25519-signed checkpoints,
[external anchoring](/operations/anchoring) so even root cannot rewrite
history undetected, and offline-verifiable exports. Building that
yourself is a few weeks of subtle work plus permanent maintenance —
canonicalization, key handling, retention that doesn't break the chain —
which is exactly the part clomp packages, with
[tests and reference vectors](/reference/hash-chain).

## When not to choose clomp

In the interest of the same honesty:

- **It is alpha software** (v0.2.x). Pre-1.0 releases may contain
  breaking changes; see the [roadmap](https://github.com/sockulags/clomp/blob/main/ROADMAP.md).
- **You operate it yourself.** Postgres, backups, TLS, upgrades. There is
  no hosted option today.
- **It does not collect evidence for you.** People and pipelines must
  record events; [scheduled controls](/guide/scheduled-controls) tell you
  when they haven't, but nothing records on its own.
- **No compliance workflow.** No policy templates, no task management, no
  auditor portal. A ledger, a verifier, and a report.
- **SDKs are Node-only today** (plus REST, the CLI and a GitHub Action).
