const { getPool } = require('../database');
const logger = require('../logger');

/**
 * Durable webhook delivery with bounded retry — shared by outgoing event
 * webhooks (eventWebhooks.js) and checkpoint anchoring (anchoring.js).
 *
 * Every outgoing POST is recorded in webhook_deliveries before the first
 * attempt. A failed attempt leaves the row 'pending' with an exponential
 * backoff schedule (WEBHOOK_RETRY_BASE_MS doubling per attempt, up to
 * WEBHOOK_RETRY_MAX_ATTEMPTS); an in-process sweeper retries due rows until
 * delivery succeeds ('delivered') or the attempt budget is exhausted
 * ('failed'). Rows live in PostgreSQL, so pending deliveries survive a crash
 * or restart — the sweeper simply picks them up again.
 *
 * Only a summary of the payload is stored (ids, sequence, action); the full
 * body is rebuilt from the immutable events/checkpoints tables at retry
 * time, and bearer tokens are read from the environment on every attempt —
 * the delivery log never duplicates event context or secrets.
 *
 * This adds durability and visibility, not guaranteed delivery semantics:
 * the export API remains the source of truth, webhooks stay a convenience
 * signal, and with no webhook configured nothing here runs at all.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;
const SWEEP_BATCH = 50;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // check retention hourly

// While an attempt is in flight its row is "claimed" by pushing
// next_attempt_at this far into the future, so a concurrent sweep (or a
// second replica) cannot pick up the same row and POST it twice. Must exceed
// WEBHOOK_TIMEOUT_MS; a crash mid-attempt simply makes the row due again
// once the claim expires.
const CLAIM_WINDOW_MS = 60_000;

function envInt(name, fallback, floor) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? Math.max(parsed, floor) : fallback;
}

function maxAttempts() {
  return envInt('WEBHOOK_RETRY_MAX_ATTEMPTS', 5, 1);
}

function baseDelayMs() {
  return envInt('WEBHOOK_RETRY_BASE_MS', 60000, 1000);
}

function sweepIntervalMs() {
  return envInt('WEBHOOK_SWEEP_INTERVAL_MS', 30000, 1000);
}

function retentionDays() {
  return envInt('WEBHOOK_DELIVERY_RETENTION_DAYS', 30, 1);
}

/** Delay before the next attempt: base, 2×base, 4×base, … */
function backoffDelayMs(attemptCount) {
  return baseDelayMs() * 2 ** (attemptCount - 1);
}

/** Bearer tokens are never stored; re-read from the environment per attempt. */
function tokenFor(kind) {
  return (kind === 'anchor' ? process.env.ANCHOR_WEBHOOK_TOKEN : process.env.EVENT_WEBHOOK_TOKEN) || null;
}

/**
 * Rebuild the POST body for a stored delivery from its source table.
 * Returns null when the source row no longer exists (e.g. pruned by
 * retention) — that delivery can never succeed and is marked failed.
 */
async function buildPayload(row) {
  const summary = row.payload_summary || {};
  if (row.kind === 'event') {
    const { rows } = await getPool().query(
      'SELECT * FROM events WHERE tenant_id = $1 AND sequence = $2',
      [row.tenant_id, summary.sequence]
    );
    if (!rows.length) return null;
    const { rowToEvent } = require('./chain');
    return { type: 'event', ...rowToEvent(rows[0]) };
  }

  const { rows } = await getPool().query(
    'SELECT * FROM checkpoints WHERE id = $1',
    [summary.checkpoint_id]
  );
  if (!rows.length) return null;
  const cp = rows[0];
  const { toIso } = require('./chain');
  // Field order matches the first-attempt body from anchoring.js
  // ({ type, ...createCheckpoint() }) so retried bodies are byte-identical.
  return {
    type: 'checkpoint',
    id: cp.id,
    tenant_id: cp.tenant_id,
    sequence: Number(cp.sequence),
    hash: cp.hash,
    signed_at: toIso(cp.signed_at),
    signature: cp.signature,
    public_key: cp.public_key
  };
}

/**
 * Record a failed attempt: schedule a retry, or give up when the budget is
 * exhausted (or the failure is known to be permanent). Even when this UPDATE
 * itself fails, the claim window keeps the retry rate bounded.
 */
async function recordFailure(row, err, permanent = false) {
  const attempts = Number(row.attempt_count) + 1;
  const exhausted = permanent || attempts >= maxAttempts();
  const status = exhausted ? 'failed' : 'pending';
  const nextAttemptAt = exhausted ? null : new Date(Date.now() + backoffDelayMs(attempts));

  try {
    await getPool().query(
      `UPDATE webhook_deliveries
       SET status = $2, attempt_count = $3, last_error = $4, next_attempt_at = $5, updated_at = now()
       WHERE id = $1`,
      [row.id, status, attempts, String(err && err.message || err).slice(0, 500), nextAttemptAt]
    );
  } catch (updateErr) {
    logger.error({ err: updateErr, deliveryId: row.id }, 'Failed to record webhook delivery attempt');
  }

  const context = { err, deliveryId: row.id, kind: row.kind, summary: row.payload_summary, attempts };
  if (exhausted) {
    logger.error(context, 'Webhook delivery failed permanently after exhausting retries');
  } else {
    logger.warn({ ...context, nextAttemptAt }, 'Webhook delivery failed; will retry');
  }
  return status;
}

/**
 * Perform one delivery attempt for a webhook_deliveries row and record the
 * outcome. The caller must hold the claim on the row (a fresh insert or a
 * claimed sweep pick). `payload` may be passed on the first attempt (the
 * caller still has the object in memory); retries rebuild it from the
 * source table.
 * Returns 'delivered' | 'pending' (will retry) | 'failed' (gave up).
 */
async function attempt(row, payload = null) {
  let body = payload;
  if (!body) {
    try {
      body = await buildPayload(row);
    } catch (err) {
      // Transient DB error while rebuilding: leave the row claimed. It
      // becomes due again when the claim expires, without consuming any of
      // the attempt budget — the receiver was never contacted.
      logger.warn({ err, deliveryId: row.id, kind: row.kind }, 'Could not rebuild webhook payload; will retry');
      return 'pending';
    }
    if (!body) {
      // The source event/checkpoint is gone — retrying can never succeed.
      return recordFailure(row, new Error('source row no longer exists'), true);
    }
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = tokenFor(row.kind);
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(row.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);

    await getPool().query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', attempt_count = attempt_count + 1,
           last_error = NULL, next_attempt_at = NULL, delivered_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id]
    );
    return 'delivered';
  } catch (err) {
    return recordFailure(row, err);
  }
}

/**
 * Record a new outgoing delivery and make the first attempt immediately.
 * The row is inserted with next_attempt_at one claim window ahead, so the
 * sweeper cannot race the in-flight first attempt and double-POST; the
 * attempt outcome overwrites the schedule either way.
 * Returns the attempt outcome ('delivered' | 'pending' | 'failed').
 * Throws only when the delivery row itself cannot be written.
 */
async function deliver({ tenantId, kind, url, summary, payload = null }) {
  const { rows } = await getPool().query(
    `INSERT INTO webhook_deliveries (tenant_id, kind, url, payload_summary, status, attempt_count, next_attempt_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, now() + make_interval(secs => $5))
     RETURNING id`,
    [tenantId, kind, url, JSON.stringify(summary), CLAIM_WINDOW_MS / 1000]
  );
  return attempt(
    { id: rows[0].id, tenant_id: tenantId, kind, url, attempt_count: 0, payload_summary: summary },
    payload
  );
}

/**
 * Retry every pending delivery whose backoff has elapsed. Due rows are
 * claimed atomically (their next_attempt_at pushed one claim window ahead,
 * with FOR UPDATE SKIP LOCKED) before any POST, so overlapping sweeps or
 * multiple backend instances never double-deliver a row.
 */
async function sweepPending() {
  const { rows } = await getPool().query(
    `UPDATE webhook_deliveries
     SET next_attempt_at = now() + make_interval(secs => $2), updated_at = now()
     WHERE id IN (
       SELECT id FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [SWEEP_BATCH, CLAIM_WINDOW_MS / 1000]
  );

  let delivered = 0;
  for (const row of rows) {
    if (await attempt(row) === 'delivered') delivered++;
  }
  if (rows.length) {
    logger.info({ due: rows.length, delivered }, 'Webhook delivery sweep complete');
  }
  return rows.length;
}

/** Drop finished delivery records past the retention window. */
async function pruneOld() {
  const { rowCount } = await getPool().query(
    `DELETE FROM webhook_deliveries
     WHERE status IN ('delivered', 'failed') AND created_at < now() - make_interval(days => $1)`,
    [retentionDays()]
  );
  if (rowCount) logger.info({ pruned: rowCount }, 'Pruned old webhook delivery records');
  return rowCount;
}

let sweepTimer = null;
let sweepInFlight = false;
let lastPruneAt = 0;

/**
 * Start the in-process retry sweeper. No-op unless at least one outgoing
 * webhook is configured — with webhooks off, nothing changes.
 */
function startDeliveryWorker() {
  if (sweepTimer) return false;
  if (!process.env.EVENT_WEBHOOK_URL && !process.env.ANCHOR_WEBHOOK_URL) return false;

  logger.info(
    { sweepIntervalMs: sweepIntervalMs(), maxAttempts: maxAttempts(), baseDelayMs: baseDelayMs() },
    'Starting webhook delivery worker'
  );
  sweepTimer = setInterval(async () => {
    if (sweepInFlight) return; // a slow receiver must not stack sweeps
    sweepInFlight = true;
    try {
      await sweepPending();
      if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = Date.now();
        await pruneOld();
      }
    } catch (err) {
      logger.error({ err }, 'Webhook delivery sweep failed');
    } finally {
      sweepInFlight = false;
    }
  }, sweepIntervalMs());
  if (sweepTimer.unref) sweepTimer.unref();
  return true;
}

function stopDeliveryWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  deliver,
  sweepPending,
  pruneOld,
  startDeliveryWorker,
  stopDeliveryWorker,
  backoffDelayMs
};
