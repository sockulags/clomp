# External anchoring

## The problem it solves

Every night, clomp signs the chain tip `(tenant, sequence, hash)` with the
server's Ed25519 key. That defeats an insider who rewrites database rows —
the re-hashed chain no longer matches the signed checkpoints.

But an attacker with **root on the server** has the signing key too. They
can rewrite history *and* re-sign new checkpoints. Against that adversary,
a checkpoint that only exists in the local database proves nothing.

The fix is old and simple: **put a copy of the checkpoint somewhere the
server cannot reach back and edit.** Once a checkpoint digest sits in the
auditor's inbox or an external archive, rewriting the history behind it
becomes detectable: the archived checkpoint will not match a later export.

## Configuration

Anchoring is opt-in and best-effort — a delivery failure is logged loudly
but never blocks the checkpoint job. Webhook anchors are additionally
recorded in the [webhook delivery log](/operations/integrations#delivery-log-retries)
and retried with exponential backoff. Configure either or both channels:

```bash
# Webhook: each checkpoint is POSTed as JSON
ANCHOR_WEBHOOK_URL=https://archive.example.com/clomp-anchors
ANCHOR_WEBHOOK_TOKEN=optional-bearer-token

# Email: each checkpoint digest is mailed (e.g. to the auditor)
ANCHOR_EMAIL_TO=auditor@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=clomp@example.com
SMTP_PASS=...
SMTP_FROM=clomp@example.com
```

## What the recipient gets

The email is a self-contained digest:

```
clomp signed checkpoint

tenant:     26af2c69-…
sequence:   1280
chain tip:  db4d5dabd047…
signed at:  2026-07-14T02:00:00.000Z
signature (Ed25519, base64):
MEUCIQDx…
public key:
-----BEGIN PUBLIC KEY-----
…
-----END PUBLIC KEY-----

Archive this message. To detect history rewriting, compare it against a
future JSONL export: the checkpoint for this sequence must be identical.
```

The webhook receives the same data as JSON
(`{"type":"checkpoint","tenant_id":…,"sequence":…,"hash":…,"signature":…}`).

## Closing the loop: `clomp anchor-check`

When you want to *prove* the anchor holds — during an audit, or on
suspicion — compare an archived checkpoint against a fresh export:

```bash
clomp export --out fresh.jsonl
clomp anchor-check saved-checkpoint-email.txt fresh.jsonl
```

The command validates the archived signature and confirms the export's
history at that sequence matches the anchored hash — offline, exit `1` on
mismatch. It accepts both the email text and the webhook JSON. See the
[CLI reference](/reference/cli#clomp-anchor-check-digest-export-jsonl-offline).

## Guidance

- The recipient's only job is to **keep the messages**. A mail archive with
  retention is enough; no tooling required.
- Anchor to a system the clomp server's credentials cannot delete from.
  An inbox on the same host defeats the purpose.
- The checkpoint schedule defaults to 02:00 UTC nightly
  (`CHECKPOINT_SCHEDULE`, cron syntax). Anchoring granularity = how much
  history a root-level attacker could theoretically rewrite undetected, so
  increase the frequency if that window matters to you.
