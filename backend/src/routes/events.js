const express = require('express');
const { getPool } = require('../database');
const { appendEvent, rowToEvent } = require('../services/chain');
const { requireAuth, requestTenantId } = require('../middleware/apikey');
const { ACTION_CATALOG, isKnownAction, isValidActionFormat } = require('../actions');
const logger = require('../logger');

const router = express.Router();

const MAX_JSON_BYTES = 32 * 1024;

function tooLarge(value) {
  return value != null && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES;
}

function validateEventBody(body) {
  const { action, actor, target, context, evidence, occurred_at } = body || {};

  if (!isValidActionFormat(action)) {
    return 'action is required and must be namespaced, e.g. "access.review.completed"';
  }
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || !actor.id || !actor.type) {
    return 'actor is required and must be an object with at least { type, id }';
  }
  for (const [name, value] of [['actor', actor], ['target', target], ['context', context], ['evidence', evidence]]) {
    if (tooLarge(value)) return `${name} exceeds the ${MAX_JSON_BYTES / 1024}KB limit`;
  }
  if (evidence != null && !Array.isArray(evidence)) {
    return 'evidence must be an array of { filename, sha256, size } objects';
  }
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (!item || typeof item !== 'object' || !/^[0-9a-f]{64}$/.test(String(item.sha256 || ''))) {
        return 'each evidence item needs a sha256 (64-char hex)';
      }
    }
  }
  if (occurred_at !== undefined) {
    const t = new Date(occurred_at).getTime();
    if (Number.isNaN(t)) return 'occurred_at must be a valid ISO 8601 timestamp';
    if (t > Date.now() + 60 * 60 * 1000) return 'occurred_at cannot be more than 1 hour in the future';
  }
  return null;
}

// GET /api/events/catalog — the seeded action catalog.
router.get('/catalog', requireAuth(), (req, res) => {
  res.json({ actions: ACTION_CATALOG });
});

// POST /api/events — append an event to the chain.
// Session users (admin/editor) or API keys may write.
router.post('/', requireAuth('admin', 'editor'), async (req, res) => {
  try {
    const error = validateEventBody(req.body);
    if (error) return res.status(400).json({ error });

    const { action, actor, target, context, evidence, occurred_at } = req.body;

    // Stamp how the event entered the system; the caller cannot spoof this part.
    const recordedBy = req.user
      ? { via: 'user', id: req.user.id, email: req.user.email }
      : { via: 'api_key', id: req.apiKey.id, name: req.apiKey.name };

    const event = await appendEvent(requestTenantId(req), {
      occurredAt: occurred_at,
      actor: { ...actor, recorded_by: recordedBy },
      action,
      target,
      context,
      evidence
    });

    res.status(201).json({ event, known_action: isKnownAction(action) });
  } catch (error) {
    logger.error({ err: error }, 'Error appending event');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events — list with filters and real SQL pagination.
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { action, actor_id, from, to, before_sequence, q } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);

    const conditions = ['tenant_id = $1'];
    const params = [requestTenantId(req)];

    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) {
      return res.status(400).json({ error: 'q must be a single string of at most 200 characters' });
    }
    if (q) {
      // Escape LIKE wildcards so user input matches literally; backslash is
      // the default ESCAPE character, so it must be escaped first too.
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      params.push(`%${escaped}%`);
      const n = params.length;
      conditions.push(
        `(action ILIKE $${n} OR actor->>'id' ILIKE $${n} OR actor->>'type' ILIKE $${n}` +
        ` OR target->>'id' ILIKE $${n} OR target->>'type' ILIKE $${n} OR context::text ILIKE $${n})`
      );
    }
    if (action) {
      params.push(String(action));
      conditions.push(`action = $${params.length}`);
    }
    if (actor_id) {
      params.push(String(actor_id));
      conditions.push(`actor->>'id' = $${params.length}`);
    }
    if (from) {
      params.push(new Date(from).toISOString());
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (to) {
      params.push(new Date(to).toISOString());
      conditions.push(`occurred_at <= $${params.length}`);
    }
    // Keyset pagination on the chain sequence: stable even while new events land.
    if (before_sequence) {
      params.push(parseInt(before_sequence));
      conditions.push(`sequence < $${params.length}`);
    }

    params.push(limit + 1);
    const { rows } = await getPool().query(
      `SELECT * FROM events WHERE ${conditions.join(' AND ')}
       ORDER BY sequence DESC LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(rowToEvent);
    res.json({
      events,
      has_more: hasMore,
      next_before_sequence: hasMore ? events[events.length - 1].sequence : null
    });
  } catch (error) {
    logger.error({ err: error }, 'Error listing events');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:sequence — one event by chain position.
router.get('/:sequence', requireAuth(), async (req, res) => {
  try {
    const sequence = parseInt(req.params.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      return res.status(400).json({ error: 'sequence must be a positive integer' });
    }
    const { rows } = await getPool().query(
      'SELECT * FROM events WHERE tenant_id = $1 AND sequence = $2',
      [requestTenantId(req), sequence]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rowToEvent(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching event');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
