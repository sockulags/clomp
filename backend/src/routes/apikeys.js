const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../database');
const { requireRole } = require('../middleware/session');
const { generateApiKey, hashKey } = require('../middleware/apikey');
const logger = require('../logger');

const router = express.Router();

// API key management is admin-only.
router.use(requireRole('admin'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate an optional expires_at value from a request body.
 * Returns { value } (null when absent) or { error }.
 */
function parseExpiresAt(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') {
    return { error: 'expires_at must be an ISO 8601 timestamp' };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { error: 'expires_at must be an ISO 8601 timestamp' };
  }
  if (date.getTime() <= Date.now()) {
    return { error: 'expires_at must be in the future' };
  }
  return { value: date.toISOString() };
}

// GET /api/keys
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, prefix, created_at, revoked_at, expires_at, last_used_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenant_id]
    );
    res.json({ keys: rows });
  } catch (error) {
    logger.error({ err: error }, 'Error listing API keys');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/keys { name, expires_at? } — the full key is returned exactly once.
router.post('/', async (req, res) => {
  try {
    const { name, expires_at } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const expiry = parseExpiresAt(expires_at);
    if (expiry.error) return res.status(400).json({ error: expiry.error });

    const key = generateApiKey();
    const id = crypto.randomUUID();
    await getPool().query(
      'INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.user.tenant_id, name, hashKey(key), key.slice(0, 16), expiry.value]
    );
    res.status(201).json({ id, name, key, expires_at: expiry.value });
  } catch (error) {
    logger.error({ err: error }, 'Error creating API key');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/keys/:id/rotate { expires_at? } — atomically revoke the old key and
// create a replacement with the same name. The new secret is returned exactly
// once. Expiry is set explicitly like at creation (omit for no expiry); the old
// key's expiry is not inherited.
router.post('/:id/rotate', async (req, res) => {
  try {
    // A malformed id can never match a key; answer 404 instead of letting
    // Postgres raise a uuid cast error (which would surface as a 500).
    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ error: 'API key not found or already revoked' });
    }
    const expiry = parseExpiresAt((req.body || {}).expires_at);
    if (expiry.error) return res.status(400).json({ error: expiry.error });

    const key = generateApiKey();
    const newId = crypto.randomUUID();
    // A single data-modifying CTE makes revoke + replace atomic: either both
    // happen or neither does, and a concurrent rotate loses the race cleanly.
    const { rows } = await getPool().query(
      `WITH old AS (
         UPDATE api_keys SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
         RETURNING name
       )
       INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, expires_at)
       SELECT $3, $2, old.name, $4, $5, $6 FROM old
       RETURNING id, name, expires_at`,
      [req.params.id, req.user.tenant_id, newId, hashKey(key), key.slice(0, 16), expiry.value]
    );
    if (!rows.length) return res.status(404).json({ error: 'API key not found or already revoked' });

    res.status(201).json({
      id: rows[0].id,
      name: rows[0].name,
      key,
      expires_at: rows[0].expires_at,
      rotated_from: req.params.id
    });
  } catch (error) {
    logger.error({ err: error }, 'Error rotating API key');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/keys/:id — revoke (kept for the audit trail, never hard-deleted).
router.delete('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ error: 'API key not found or already revoked' });
    }
    const { rows } = await getPool().query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'API key not found or already revoked' });
    res.json({ revoked: true });
  } catch (error) {
    logger.error({ err: error }, 'Error revoking API key');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
