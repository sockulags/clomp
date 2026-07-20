const express = require('express');
const crypto = require('crypto');
const argon2 = require('argon2');
const { getPool } = require('../database');
const { requireRole } = require('../middleware/session');
const logger = require('../logger');

const router = express.Router();
const VALID_ROLES = ['admin', 'editor', 'auditor'];

// All user management is admin-only.
router.use(requireRole('admin'));

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, email, name, role, totp_enabled, disabled, created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenant_id]
    );
    res.json({ users: rows });
  } catch (error) {
    logger.error({ err: error }, 'Error listing users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users { email, name, role } — returns a one-time initial password.
router.post('/', async (req, res) => {
  try {
    const { email, name, role } = req.body || {};
    if (!email || !name || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `email, name and role (${VALID_ROLES.join('/')}) are required` });
    }

    const initialPassword = crypto.randomBytes(12).toString('base64url');
    const id = crypto.randomUUID();
    // New users join the acting admin's tenant (identical to the default
    // tenant on single-tenant installs) — never any other.
    await getPool().query(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user.tenant_id, String(email).toLowerCase(), name, await argon2.hash(initialPassword), role]
    );
    res.status(201).json({ id, email: String(email).toLowerCase(), name, role, initial_password: initialPassword });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    logger.error({ err: error }, 'Error creating user');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/users/:id { role?, disabled? }
router.patch('/:id', async (req, res) => {
  try {
    const { role, disabled } = req.body || {};
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (req.params.id === req.user.id && (disabled === true || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'You cannot disable or demote your own account' });
    }

    const { rows } = await getPool().query(
      `UPDATE users SET
         role = COALESCE($1, role),
         disabled = COALESCE($2, disabled)
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, email, name, role, disabled`,
      [role ?? null, typeof disabled === 'boolean' ? disabled : null, req.params.id, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (error) {
    logger.error({ err: error }, 'Error updating user');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users/:id/reset-password — returns a new one-time password.
router.post('/:id/reset-password', async (req, res) => {
  try {
    const newPassword = crypto.randomBytes(12).toString('base64url');
    const { rows } = await getPool().query(
      `UPDATE users SET password_hash = $1, totp_enabled = false, totp_secret = NULL
       WHERE id = $2 AND tenant_id = $3 RETURNING id, email`,
      [await argon2.hash(newPassword), req.params.id, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await getPool().query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    res.json({ id: rows[0].id, email: rows[0].email, initial_password: newPassword });
  } catch (error) {
    logger.error({ err: error }, 'Error resetting password');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
