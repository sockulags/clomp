const logger = require('../logger');

/**
 * External anchoring of signed checkpoints (opt-in).
 *
 * A checkpoint stored only in the local database proves nothing against an
 * attacker with full control of the server: they can rewrite history and
 * re-sign new checkpoints. Sending each nightly checkpoint to an external
 * recipient (the auditor's inbox, a webhook that archives it) makes rewriting
 * detectable — the archived checkpoint will not match a later export.
 *
 * Anchoring is best-effort: a delivery failure is logged loudly but never
 * fails the checkpoint job itself. Webhook anchors are additionally recorded
 * in webhook_deliveries and retried with backoff (see webhookDeliveries.js).
 */

function webhookConfig() {
  const url = process.env.ANCHOR_WEBHOOK_URL;
  if (!url) return null;
  return { url, token: process.env.ANCHOR_WEBHOOK_TOKEN || null };
}

function emailConfig() {
  const to = process.env.ANCHOR_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  if (!to || !host) return null;
  return {
    to,
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || 'clomp@localhost'
  };
}

function isConfigured() {
  return Boolean(webhookConfig() || emailConfig());
}

/** The archived record: everything needed to verify against a later export. */
function checkpointDigest(checkpoint) {
  return [
    'clomp signed checkpoint',
    '',
    `tenant:     ${checkpoint.tenant_id}`,
    `sequence:   ${checkpoint.sequence}`,
    `chain tip:  ${checkpoint.hash}`,
    `signed at:  ${checkpoint.signed_at}`,
    `signature (Ed25519, base64):`,
    checkpoint.signature,
    'public key:',
    checkpoint.public_key.trim(),
    '',
    'Archive this message. To detect history rewriting, compare it against a',
    'future JSONL export: the checkpoint for this sequence must be identical.'
  ].join('\n');
}

async function anchorToWebhook(checkpoint, config) {
  // Route through the durable delivery log: a failed anchor is retried with
  // backoff by the delivery worker instead of being silently dropped.
  const deliveries = require('./webhookDeliveries');
  const status = await deliveries.deliver({
    tenantId: checkpoint.tenant_id,
    kind: 'anchor',
    url: config.url,
    summary: { checkpoint_id: checkpoint.id, sequence: checkpoint.sequence, hash: checkpoint.hash },
    payload: { type: 'checkpoint', ...checkpoint }
  });
  if (status !== 'delivered') {
    throw new Error('checkpoint webhook delivery failed (recorded for retry)');
  }
}

async function anchorToEmail(checkpoint, config) {
  // Lazy: nodemailer is only loaded when email anchoring is configured.
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined
  });
  await transport.sendMail({
    from: config.from,
    to: config.to,
    subject: `clomp checkpoint — sequence ${checkpoint.sequence} (${String(checkpoint.hash).slice(0, 12)}…)`,
    text: checkpointDigest(checkpoint)
  });
}

/**
 * Deliver a checkpoint to every configured external anchor.
 * Returns { webhook, email } with 'ok' | 'failed' | 'skipped' per channel.
 */
async function anchorCheckpoint(checkpoint) {
  const result = { webhook: 'skipped', email: 'skipped' };

  const webhook = webhookConfig();
  if (webhook) {
    try {
      await anchorToWebhook(checkpoint, webhook);
      result.webhook = 'ok';
      logger.info({ sequence: checkpoint.sequence }, 'Checkpoint anchored via webhook');
    } catch (err) {
      result.webhook = 'failed';
      logger.error({ err, sequence: checkpoint.sequence }, 'Checkpoint webhook anchoring FAILED — history rewrites are not externally detectable for this checkpoint');
    }
  }

  const email = emailConfig();
  if (email) {
    try {
      await anchorToEmail(checkpoint, email);
      result.email = 'ok';
      logger.info({ sequence: checkpoint.sequence, to: email.to }, 'Checkpoint anchored via email');
    } catch (err) {
      result.email = 'failed';
      logger.error({ err, sequence: checkpoint.sequence }, 'Checkpoint email anchoring FAILED — history rewrites are not externally detectable for this checkpoint');
    }
  }

  return result;
}

module.exports = { isConfigured, anchorCheckpoint, checkpointDigest };
