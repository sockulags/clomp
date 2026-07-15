const logger = require('../logger');

/**
 * Outgoing event webhooks (opt-in).
 *
 * POST every newly appended event to EVENT_WEBHOOK_URL — the hook for Slack
 * relays, SIEM forwarding and automations, without clomp knowing anything
 * about the receiver. Optionally filter with EVENT_WEBHOOK_ACTIONS, a
 * comma-separated list of action prefixes (e.g. "incident.,retention.").
 *
 * Delivery is fire-and-forget with a timeout: the chain append has already
 * committed, and an unreachable receiver must never fail or slow down
 * recording. Failures are logged; there is no retry queue — the export API
 * is the source of truth, webhooks are a convenience signal.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;

function config() {
  const url = process.env.EVENT_WEBHOOK_URL;
  if (!url) return null;
  const prefixes = (process.env.EVENT_WEBHOOK_ACTIONS || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  return { url, token: process.env.EVENT_WEBHOOK_TOKEN || null, prefixes };
}

function isConfigured() {
  return Boolean(config());
}

function matches(action, prefixes) {
  if (!prefixes.length) return true;
  return prefixes.some(p => action.startsWith(p));
}

/**
 * Dispatch an appended event to the configured webhook. Never throws; call
 * without awaiting from the append path.
 */
async function dispatchEvent(event) {
  const cfg = config();
  if (!cfg || !matches(event.action, cfg.prefixes)) return 'skipped';

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'event', ...event }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
    return 'ok';
  } catch (err) {
    logger.error({ err, sequence: event.sequence, action: event.action }, 'Event webhook delivery failed');
    return 'failed';
  }
}

module.exports = { isConfigured, dispatchEvent };
