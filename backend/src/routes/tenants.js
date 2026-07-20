const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, getDefaultTenantId, TENANT_SLUG_PATTERN } = require('../database');
const { requireRole } = require('../middleware/session');
const { appendEvent } = require('../services/chain');
const logger = require('../logger');

const router = express.Router();

/**
 * Multi-tenant management — first slice, opt-in via MULTI_TENANT=true.
 * One installation serving several client organizations (the MSP/consultant
 * case): each tenant gets its own users, API keys, hash chain, checkpoints
 * and advisory locks. With the flag off these endpoints do not exist (404),
 * so a default single-tenant install behaves exactly as before.
 */
function multiTenantEnabled() {
  return process.env.MULTI_TENANT === 'true';
}

router.use((req, res, next) => {
  if (!multiTenantEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
});

// Tenant management is admin-only and session-only (API keys belong to one
// tenant and must never manage the roster) — and reserved for admins of the
// operator's own tenant, the one created at first start. A client tenant's
// admin must not see, rename or deactivate other client organizations.
router.use(requireRole('admin'));
router.use((req, res, next) => {
  if (req.user.tenant_id !== getDefaultTenantId()) {
    return res.status(403).json({ error: 'Tenant management is restricted to the operator tenant' });
  }
  return next();
});

// Malformed ids would make Postgres throw (22P02) before the WHERE clause
// can miss — map them to the same 404 an unknown tenant gets.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_PATTERN.test(id)) {
    return res.status(404).json({ error: 'Tenant not found' });
  }
  return next();
});

/** Returns the trimmed display name, or null when invalid. */
function validDisplayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return null;
  return value.trim();
}
const DISPLAY_NAME_ERROR = 'display_name is required and must be at most 200 characters';

function rowToTenant(row) {
  return {
    id: row.id,
    slug: row.name,
    display_name: row.display_name || row.name,
    active: row.active,
    created_at: row.created_at
  };
}

/**
 * Tenant lifecycle changes are recorded on the acting admin's own chain,
 * following the scheduled-controls pattern: the roster of client orgs is
 * part of what the installation attests to.
 */
async function recordTenantChange(req, action, tenant) {
  await appendEvent(req.user.tenant_id, {
    actor: {
      type: 'user',
      id: req.user.email,
      recorded_by: { via: 'user', id: req.user.id, email: req.user.email }
    },
    action,
    target: { type: 'tenant', id: tenant.id, name: tenant.slug },
    context: {
      slug: tenant.slug,
      display_name: tenant.display_name,
      active: tenant.active
    }
  });
}

// GET /api/tenants — the full roster, active and deactivated.
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, display_name, active, created_at
       FROM tenants ORDER BY created_at ASC`
    );
    res.json({ tenants: rows.map(rowToTenant) });
  } catch (error) {
    logger.error({ err: error }, 'Error listing tenants');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tenants { slug, display_name } — create a tenant.
router.post('/', async (req, res) => {
  try {
    const { slug } = req.body || {};
    if (typeof slug !== 'string' || !TENANT_SLUG_PATTERN.test(slug)) {
      return res.status(400).json({ error: 'slug is required: lowercase letters, digits and hyphens (max 63 chars, no leading/trailing hyphen)' });
    }
    const displayName = validDisplayName((req.body || {}).display_name);
    if (displayName === null) {
      return res.status(400).json({ error: DISPLAY_NAME_ERROR });
    }

    const { rows } = await getPool().query(
      `INSERT INTO tenants (id, name, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, display_name, active, created_at`,
      [randomUUID(), slug, displayName]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'A tenant with that slug already exists' });
    }

    const tenant = rowToTenant(rows[0]);
    await recordTenantChange(req, 'tenant.created', tenant);
    res.status(201).json({ tenant });
  } catch (error) {
    logger.error({ err: error }, 'Error creating tenant');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/tenants/:id { display_name } — rename. The slug is the stable
// identifier (referenced by scripts and provisioning) and cannot change.
router.patch('/:id', async (req, res) => {
  try {
    const displayName = validDisplayName((req.body || {}).display_name);
    if (displayName === null) {
      return res.status(400).json({ error: DISPLAY_NAME_ERROR });
    }

    const { rows } = await getPool().query(
      `UPDATE tenants SET display_name = $1
       WHERE id = $2
       RETURNING id, name, display_name, active, created_at`,
      [displayName, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

    const tenant = rowToTenant(rows[0]);
    await recordTenantChange(req, 'tenant.renamed', tenant);
    res.json({ tenant });
  } catch (error) {
    logger.error({ err: error }, 'Error renaming tenant');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Shared flow for soft-deactivate and reactivate. */
async function setTenantActive(req, res, { active, action, label }) {
  try {
    const { rows } = await getPool().query(
      `UPDATE tenants SET active = $1
       WHERE id = $2 AND active = $3
       RETURNING id, name, display_name, active, created_at`,
      [active, req.params.id, !active]
    );
    if (!rows.length) {
      return res.status(404).json({ error: `Tenant not found or already ${active ? 'active' : 'deactivated'}` });
    }

    const tenant = rowToTenant(rows[0]);
    await recordTenantChange(req, action, tenant);
    res.json({ tenant });
  } catch (error) {
    logger.error({ err: error }, `Error ${label} tenant`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/tenants/:id — soft-deactivate. The chain is append-only, so a
// tenant is never hard-deleted: its history stays verifiable, but its users
// and API keys stop resolving.
router.delete('/:id', (req, res) => {
  // Postgres compares UUIDs case-insensitively — normalize before the
  // self-lockout guard so an uppercase id cannot slip past it.
  if (req.params.id.toLowerCase() === String(req.user.tenant_id).toLowerCase()) {
    return res.status(400).json({ error: 'You cannot deactivate your own tenant' });
  }
  return setTenantActive(req, res, { active: false, action: 'tenant.deactivated', label: 'deactivating' });
});

// POST /api/tenants/:id/activate — undo a deactivation.
router.post('/:id/activate', (req, res) => {
  return setTenantActive(req, res, { active: true, action: 'tenant.reactivated', label: 'reactivating' });
});

module.exports = router;
