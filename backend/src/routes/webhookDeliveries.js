const express = require('express');
const { getPool } = require('../database');
const { requireRole } = require('../middleware/session');
const logger = require('../logger');

const router = express.Router();

const STATUSES = ['pending', 'delivered', 'failed'];
const KINDS = ['event', 'anchor'];

// Troubleshooting surface for outgoing webhooks — admin-only, like the rest
// of the admin panel. API keys have no access.
router.use(requireRole('admin'));

/** Shape a DB row for the API (BIGSERIAL id comes back as a string). */
function rowToDelivery(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    url: row.url,
    payload_summary: row.payload_summary,
    status: row.status,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    next_attempt_at: row.next_attempt_at,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// GET /api/webhook-deliveries — delivery log, newest first, keyset-paginated.
router.get('/', async (req, res) => {
  try {
    const { status, kind, before_id } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);

    const conditions = ['tenant_id = $1'];
    const params = [req.user.tenant_id];

    if (status !== undefined) {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${STATUSES.join('/')}` });
      }
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (kind !== undefined) {
      if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${KINDS.join('/')}` });
      }
      params.push(kind);
      conditions.push(`kind = $${params.length}`);
    }
    // Keyset pagination on the serial id: stable while new deliveries land.
    if (before_id !== undefined) {
      const cursor = parseInt(before_id);
      if (!Number.isInteger(cursor) || cursor < 1) {
        return res.status(400).json({ error: 'before_id must be a positive integer' });
      }
      params.push(cursor);
      conditions.push(`id < $${params.length}`);
    }

    params.push(limit + 1);
    const { rows } = await getPool().query(
      `SELECT * FROM webhook_deliveries WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const deliveries = rows.slice(0, limit).map(rowToDelivery);
    res.json({
      deliveries,
      has_more: hasMore,
      next_before_id: hasMore ? deliveries[deliveries.length - 1].id : null
    });
  } catch (error) {
    logger.error({ err: error }, 'Error listing webhook deliveries');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
