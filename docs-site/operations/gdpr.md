# GDPR & personal data

An append-only ledger and a right to erasure sound incompatible. They are
not — but only if you decide *before you record* what goes into the chain
and what stays outside it. This page explains exactly what in clomp is
immutable, what can be deleted, and the recording pattern that keeps an
immutable chain compatible with erasure requests.

::: warning Not legal advice
This is engineering guidance about what clomp can and cannot do, written to
help you have an informed conversation with your data protection officer.
It is not legal advice, and GDPR questions are always assessed case by
case. Involve your DPO before deciding what to record.
:::

## What is immutable, exactly

The hash chain covers, for every event: `tenant_id`, `sequence`,
`occurred_at`, `recorded_at`, `actor`, `action`, `target`, `context` and
the `evidence` array (`filename`, `sha256`, `size` per attachment) — see
the [hash chain specification](/reference/hash-chain). Whatever you put in
those fields cannot be changed or removed later without breaking
verification. There is no edit or delete API, and a database trigger
rejects `UPDATE`/`DELETE` on events for every role. That is the product
working as intended.

Two things are **not** in the chain:

- **Evidence file contents.** Only the file's SHA-256, filename and size
  are hashed. The bytes live on disk (`EVIDENCE_DIR`), outside the chain.
- **Everything else in the database** — users, sessions, API keys, the
  evidence-file metadata table. Normal tables, normally erasable.

One thing *is* in the chain that you do not control per-event: clomp
stamps every event with how it entered the system
(`actor.recorded_by`). For events recorded by a logged-in user this
includes the user's id **and email address**; for API keys it is the key's
id and name. This is deliberate accountability data — an audit trail that
does not say who wrote to it is not much of an audit trail — and it is
permanent. The practical consequences:

- The identity of your operators and editors (typically employees acting
  in their professional role) will be permanently recorded. Most
  organizations process this under a legal obligation or legitimate
  interest, the same basis as any access log — confirm with your DPO.
- For machine-recorded events, name API keys after systems (`ci`,
  `patch-runner`), not people.

## The pattern: pseudonymous identifiers, erasable mapping

The mistake to avoid is putting direct identifiers of **data subjects** —
the people your events are *about* — into event payloads:

```jsonc
// Don't: the email is now in the chain forever
{ "action": "access.review.completed",
  "target": { "type": "user", "id": "anna.svensson@example.com" } }

// Do: an opaque identifier only your source system can resolve
{ "action": "access.review.completed",
  "target": { "type": "user", "id": "user:1042" } }
```

Record `user:1042`, not the email. The mapping from `user:1042` to a
person lives where it already lives: your IdP, your HR system, your
application's user table — systems that support deletion.

When an erasure request arrives, you erase the mapping (or the source
record it points to). What remains in the chain is an opaque identifier
that no longer relates to an identifiable person. This is the same move as
crypto-shredding: destroy the key — here, the mapping — and what remains
is inert. Deleting the linkage rather than the ledger entry is the
established approach for immutable data structures, but whether it
satisfies erasure *in your case* depends on what else the event reveals —
which is why the rest of the payload matters too:

- **`context` is free-form. Treat it as radioactive.** Do not dump request
  bodies, form contents or ticket text into it. Names, emails and free
  text in `context` are unerasable.
- **Filenames are hashed.** `review-of-anna-svensson.xlsx` puts a name in
  the chain even after the file itself is deleted. Name evidence files
  neutrally (`access-review-2026-q3.xlsx`).
- **Actor vs. subject.** The `actor` is usually an employee doing security
  work under a professional role (see `recorded_by` above). The `target`
  is often where data subjects appear — pseudonymize there first.

## Evidence files can be deleted

Because evidence is content-addressed and only its hash is chained,
deleting an evidence file does **not** break verification: `GET
/api/verify` and the offline verifier recompute hashes from event data
only and never read file contents. If an uploaded file contains personal
data that must be erased:

1. Delete the file from `EVIDENCE_DIR` (files are stored at
   `<EVIDENCE_DIR>/<first two hex chars>/<sha256>`).
2. Optionally delete its row from the `evidence_files` table (a normal
   table; it also stores the uploader's identity).
3. Remove the file from any backups per your backup retention policy.

Afterward the chain still verifies, the event still shows *that* evidence
existed (hash, filename, size), and `GET /api/evidence/:sha256` returns
404. You have traded the ability to produce that file to an auditor for
the erasure — the record of its existence is what remains.

## Retention pruning: storage limitation

Erasure requests aside, the GDPR's storage-limitation principle means you
should not keep event data longer than you need it. clomp ships a pruning
path that deletes old events **without** destroying chain verifiability:
it cuts only at a signed checkpoint, archives the pruned range to
verifiable JSONL first, and appends a `retention.pruned` event to the
chain (`backend/scripts/retention-prune.js`). See
[Retention](/operations/retention).

Note that pruning archives before it deletes. If the goal is erasure
rather than storage hygiene, the archive file inherits the problem —
apply the same retention policy to archives, or rely on the pseudonymous
pattern so archives contain no direct identifiers either.

## What clomp will not do

There is no supported way to edit or delete an individual event, and none
is planned. Any mechanism that could rewrite a single entry — even for a
good reason — would be a mechanism an attacker or a dishonest operator
could use too, and the product's entire value is that no such mechanism
exists. If a direct identifier does end up in the chain despite the
guidance above, your options are the mapping-erasure argument, waiting
for the retention cutoff, or — worst case — a prune of the containing
range at the cost of the pruned history living only in the (also
deletable) archive. Design the payloads so it does not come to that.

## Checklist

- Data subjects appear in events as opaque IDs (`user:1042`), never as
  names or emails.
- The ID-to-person mapping lives in a system that supports deletion.
- `context` contains no free text about identifiable people.
- Evidence filenames are neutral.
- API keys are named after systems, not people.
- Operators know their email is permanently recorded on events they
  create (`recorded_by`), and your lawful basis for that is documented.
- Retention policy set — for the ledger
  ([pruning](/operations/retention)), for evidence files, and for
  archives and backups.
