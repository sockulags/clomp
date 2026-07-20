const logger = require('../logger');

/**
 * Outgoing event webhooks (opt-in).
 *
 * POST every newly appended event to EVENT_WEBHOOK_URL — the hook for Slack
 * relays, SIEM forwarding and automations, without clomp knowing anything
 * about the receiver. Optionally filter with EVENT_WEBHOOK_ACTIONS, a
 * comma-separated list of action prefixes (e.g. "incident.,retention.").
 *
 * Delivery is asynchronous with a timeout: the chain append has already
 * committed, and an unreachable receiver must never fail or slow down
 * recording. Each delivery is recorded in webhook_deliveries and failures
 * are retried with exponential backoff (see webhookDeliveries.js) — but the
 * export API remains the source of truth; webhooks are a convenience signal.
 */

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
 * without awaiting from the append path. The delivery is recorded first, so
 * a failed first attempt is retried by the delivery worker.
 */
async function dispatchEvent(event) {
  const cfg = config();
  if (!cfg || !matches(event.action, cfg.prefixes)) return 'skipped';

  try {
    // Lazy require to keep module load order (and tests) simple.
    const deliveries = require('./webhookDeliveries');
    const status = await deliveries.deliver({
      tenantId: event.tenant_id,
      kind: 'event',
      url: cfg.url,
      summary: { event_id: event.id, sequence: event.sequence, action: event.action },
      payload: { type: 'event', ...event }
    });
    return status === 'delivered' ? 'ok' : 'failed';
  } catch (err) {
    logger.error({ err, sequence: event.sequence, action: event.action }, 'Event webhook delivery failed');
    return 'failed';
  }
}

module.exports = { isConfigured, dispatchEvent };
