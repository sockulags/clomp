const express = require('express');
const crypto = require('crypto');
const { getPool, getDefaultTenantId } = require('../database');
const { requireRole } = require('../middleware/session');
const { generateApiKey, hashKey } = require('../middleware/apikey');
const logger = require('../logger');

const router = express.Router();

// API key management is admin-only.
router.use(requireRole('admin'));

// GET /api/keys
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, prefix, created_at, revoked_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenant_id]
    );
    res.json({ keys: rows });
  } catch (error) {
    logger.error({ err: error }, 'Error listing API keys');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/keys { name } — the full key is returned exactly once.
router.post('/', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const key = generateApiKey();
    const id = crypto.randomUUID();
    await getPool().query(
      'INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4, $5)',
      [id, getDefaultTenantId(), name, hashKey(key), key.slice(0, 16)]
    );
    res.status(201).json({ id, name, key });
  } catch (error) {
    logger.error({ err: error }, 'Error creating API key');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/keys/:id — revoke (kept for the audit trail, never hard-deleted).
router.delete('/:id', async (req, res) => {
  try {
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
