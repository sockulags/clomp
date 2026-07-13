const crypto = require('crypto');
const { canonicalize } = require('./canonical');

// Genesis: the prev_hash of the first event in every tenant chain.
const GENESIS_HASH = '0'.repeat(64);

/**
 * The exact field set that is hashed for an event. Anything not listed here
 * (like the row id) can change storage representation without breaking the
 * chain; anything listed here is tamper-evident.
 */
function canonicalEventPayload(event) {
  return canonicalize({
    tenant_id: event.tenant_id,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    actor: event.actor,
    action: event.action,
    target: event.target ?? null,
    context: event.context ?? null,
    evidence: event.evidence ?? null
  });
}

/**
 * hash = SHA-256( prev_hash_bytes || utf8(canonical_payload) ), hex-encoded.
 * prevHashHex must be 64 hex chars (GENESIS_HASH for the first event).
 */
function eventHash(prevHashHex, event) {
  if (!/^[0-9a-f]{64}$/.test(prevHashHex)) {
    throw new Error('prev_hash must be a 64-char lowercase hex string');
  }
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(prevHashHex, 'hex'));
  h.update(Buffer.from(canonicalEventPayload(event), 'utf8'));
  return h.digest('hex');
}

module.exports = { GENESIS_HASH, canonicalEventPayload, eventHash };
