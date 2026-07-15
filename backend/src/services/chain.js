const { randomUUID } = require('crypto');
const { getPool } = require('../database');
const { GENESIS_HASH, eventHash } = require('../hashchain');

/**
 * Normalize a JS Date (or ISO string) to the exact string representation that
 * is hashed and returned by the API: ISO 8601 with millisecond precision, UTC.
 * pg parses TIMESTAMPTZ into Date objects with ms precision, so this
 * round-trips losslessly as long as we never store sub-millisecond input.
 */
function toIso(value) {
  return new Date(value).toISOString();
}

/** Shape a DB row into the hashable/serializable event object. */
function rowToEvent(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    sequence: Number(row.sequence),
    occurred_at: toIso(row.occurred_at),
    recorded_at: toIso(row.recorded_at),
    actor: row.actor,
    action: row.action,
    target: row.target,
    context: row.context,
    evidence: row.evidence,
    prev_hash: row.prev_hash,
    hash: row.hash
  };
}

/**
 * Append an event to a tenant's chain.
 *
 * Runs in a transaction holding a per-tenant advisory lock so sequence
 * numbers are gap-free and the chain never forks under concurrent writes.
 */
async function appendEvent(tenantId, { occurredAt, actor, action, target, context, evidence }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);

    const tip = await client.query(
      'SELECT sequence, hash FROM events WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1',
      [tenantId]
    );

    const sequence = tip.rows.length ? Number(tip.rows[0].sequence) + 1 : 1;
    const prevHash = tip.rows.length ? tip.rows[0].hash : GENESIS_HASH;

    const event = {
      id: randomUUID(),
      tenant_id: tenantId,
      sequence,
      occurred_at: toIso(occurredAt || new Date()),
      recorded_at: toIso(new Date()),
      actor,
      action,
      target: target ?? null,
      context: context ?? null,
      evidence: evidence ?? null,
      prev_hash: prevHash
    };
    event.hash = eventHash(prevHash, event);

    await client.query(
      `INSERT INTO events (id, tenant_id, sequence, occurred_at, recorded_at,
                           actor, action, target, context, evidence, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.id, event.tenant_id, event.sequence, event.occurred_at, event.recorded_at,
        JSON.stringify(event.actor), event.action,
        event.target === null ? null : JSON.stringify(event.target),
        event.context === null ? null : JSON.stringify(event.context),
        event.evidence === null ? null : JSON.stringify(event.evidence),
        event.prev_hash, event.hash
      ]
    );

    await client.query('COMMIT');

    // Outgoing webhook, after commit and without awaiting: an unreachable
    // receiver must never fail or slow down recording.
    const webhooks = require('./eventWebhooks');
    if (webhooks.isConfigured()) {
      webhooks.dispatchEvent(event).catch(() => {});
    }

    return event;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Recompute the hash chain over a sequence range.
 * Returns { intact, verified, firstBreak } — firstBreak is the sequence of
 * the first event whose stored hash does not match the recomputed one, or
 * whose prev_hash does not match its predecessor.
 *
 * Streams in batches so verification stays flat in memory.
 */
async function verifyChain(tenantId, fromSequence = 1, toSequence = null) {
  const pool = getPool();
  const BATCH = 1000;

  let expectedPrev = null;
  let anchor = null;
  if (fromSequence <= 1) {
    fromSequence = 1;
    expectedPrev = GENESIS_HASH;

    // Retention may have pruned the oldest events. The remaining chain then
    // starts above sequence 1 and must anchor at a signed checkpoint whose
    // (sequence, hash) matches the first retained event's predecessor.
    const { rows: minRows } = await pool.query(
      'SELECT MIN(sequence) AS min FROM events WHERE tenant_id = $1',
      [tenantId]
    );
    const minSeq = minRows.length && minRows[0].min !== null ? Number(minRows[0].min) : null;
    if (minSeq !== null && minSeq > 1) {
      const { rows: firstRows } = await pool.query(
        'SELECT prev_hash FROM events WHERE tenant_id = $1 AND sequence = $2',
        [tenantId, minSeq]
      );
      const { rows: cpRows } = await pool.query(
        'SELECT hash FROM checkpoints WHERE tenant_id = $1 AND sequence = $2 ORDER BY signed_at DESC LIMIT 1',
        [tenantId, minSeq - 1]
      );
      if (!cpRows.length || cpRows[0].hash !== firstRows[0].prev_hash) {
        return {
          intact: false, verified: 0, firstBreak: minSeq,
          reason: 'history before this sequence was removed without a matching signed checkpoint anchor'
        };
      }
      expectedPrev = firstRows[0].prev_hash;
      fromSequence = minSeq;
      anchor = { sequence: minSeq - 1, hash: expectedPrev };
    }
  } else {
    const prevRow = await pool.query(
      'SELECT hash FROM events WHERE tenant_id = $1 AND sequence = $2',
      [tenantId, fromSequence - 1]
    );
    if (!prevRow.rows.length) {
      return { intact: false, verified: 0, firstBreak: fromSequence - 1, reason: 'missing predecessor event' };
    }
    expectedPrev = prevRow.rows[0].hash;
  }

  let verified = 0;
  let cursor = fromSequence - 1;
  let expectedSequence = fromSequence;

  for (;;) {
    const params = [tenantId, cursor];
    let sql = `SELECT * FROM events WHERE tenant_id = $1 AND sequence > $2`;
    if (toSequence !== null) {
      params.push(toSequence);
      sql += ' AND sequence <= $3';
    }
    sql += ` ORDER BY sequence ASC LIMIT ${BATCH}`;

    const { rows } = await pool.query(sql, params);
    if (!rows.length) break;

    for (const row of rows) {
      const event = rowToEvent(row);
      if (event.sequence !== expectedSequence) {
        return { intact: false, verified, firstBreak: expectedSequence, reason: 'sequence gap' };
      }
      if (event.prev_hash !== expectedPrev) {
        return { intact: false, verified, firstBreak: event.sequence, reason: 'prev_hash mismatch' };
      }
      const recomputed = eventHash(event.prev_hash, event);
      if (recomputed !== event.hash) {
        return { intact: false, verified, firstBreak: event.sequence, reason: 'hash mismatch' };
      }
      expectedPrev = event.hash;
      expectedSequence = event.sequence + 1;
      cursor = event.sequence;
      verified++;
    }

    if (rows.length < BATCH) break;
  }

  return anchor ? { intact: true, verified, anchored_at: anchor } : { intact: true, verified };
}

module.exports = { appendEvent, verifyChain, rowToEvent, toIso };
