const express = require('express');
const crypto = require('crypto');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../database');
const { createSession, destroySession, setSessionCookie, clearSessionCookie, requireRole } = require('../middleware/session');
const { generateSecret, verifyTotp, otpauthUrl } = require('../totp');
const logger = require('../logger');

const router = express.Router();

// Login attempts are the most brute-forceable surface — keep this tight.
const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '10'),
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

async function consumeRecoveryCode(userId, code) {
  const { rows } = await getPool().query(
    'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  for (const row of rows) {
    if (await argon2.verify(row.code_hash, code)) {
      await getPool().query('UPDATE recovery_codes SET used_at = now() WHERE id = $1', [row.id]);
      return true;
    }
  }
  return false;
}

// POST /api/auth/login { email, password, totp? }
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password, totp } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Users of a soft-deactivated tenant cannot sign in; with every tenant
    // active (single-tenant installs) this matches the pre-multi-tenant query.
    const { rows } = await getPool().query(
      `SELECT u.id, u.email, u.name, u.role, u.password_hash, u.totp_secret, u.totp_enabled, u.disabled
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND t.active = true`,
      [String(email).toLowerCase()]
    );
    const user = rows[0];

    // Always verify against something to keep timing flat for unknown emails.
    const hash = user
      ? user.password_hash
      : '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const passwordOk = await argon2.verify(hash, String(password)).catch(() => false);

    if (!user || user.disabled || !passwordOk) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.totp_enabled) {
      if (!totp) {
        return res.status(401).json({ error: 'TOTP code required', totp_required: true });
      }
      const totpOk = verifyTotp(user.totp_secret, totp)
        || (String(totp).length > 6 && await consumeRecoveryCode(user.id, String(totp)));
      if (!totpOk) {
        return res.status(401).json({ error: 'Invalid TOTP or recovery code' });
      }
    }

    const { token, expiresAt } = await createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, token, expiresAt);
    return res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    logger.error({ err: error }, 'Login error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    if (req.sessionToken) {
      await destroySession(req.sessionToken);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'Logout error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireRole(), (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/sessions — the signed-in user's active sessions.
router.get('/sessions', requireRole(), async (req, res) => {
  try {
    const currentHash = require('../middleware/session').hashToken(req.sessionToken);
    const { rows } = await getPool().query(
      `SELECT id, token_hash, user_agent, created_at, last_used_at, expires_at
       FROM sessions WHERE user_id = $1 AND expires_at > now()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({
      sessions: rows.map(s => ({
        id: s.id,
        user_agent: s.user_agent,
        created_at: s.created_at,
        last_used_at: s.last_used_at,
        expires_at: s.expires_at,
        current: s.token_hash === currentHash
      }))
    });
  } catch (error) {
    logger.error({ err: error }, 'Error listing sessions');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/sessions/:id — revoke one of your own sessions.
router.delete('/sessions/:id', requireRole(), async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Session not found' });
    res.json({ revoked: true });
  } catch (error) {
    logger.error({ err: error }, 'Error revoking session');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/sessions/revoke-others — sign out everywhere else.
router.post('/sessions/revoke-others', requireRole(), async (req, res) => {
  try {
    const currentHash = require('../middleware/session').hashToken(req.sessionToken);
    const { rowCount } = await getPool().query(
      'DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2',
      [req.user.id, currentHash]
    );
    res.json({ revoked: rowCount });
  } catch (error) {
    logger.error({ err: error }, 'Error revoking other sessions');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password { current_password, new_password }
// Revokes every other session so a leaked initial password stops working
// everywhere the moment it is changed.
router.post('/change-password', requireRole(), async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (typeof new_password !== 'string' || new_password.length < 10 || new_password.length > 200) {
      return res.status(400).json({ error: 'new_password must be 10–200 characters' });
    }

    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await argon2.verify(rows[0].password_hash, String(current_password || '')).catch(() => false);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await getPool().query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [await argon2.hash(new_password), req.user.id]
    );
    await getPool().query(
      'DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2',
      [req.user.id, require('../middleware/session').hashToken(req.sessionToken)]
    );
    return res.json({ changed: true });
  } catch (error) {
    logger.error({ err: error }, 'Change password error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/setup — generate a secret; enable with a valid code.
// Re-running setup while TOTP is active would silently disarm it, so an
// already-enabled account must re-authenticate with its password first.
router.post('/totp/setup', requireRole(), async (req, res) => {
  try {
    const { rows: current } = await getPool().query(
      'SELECT password_hash, totp_enabled FROM users WHERE id = $1', [req.user.id]
    );
    if (current[0].totp_enabled) {
      const ok = await argon2.verify(current[0].password_hash, String(req.body?.password || '')).catch(() => false);
      if (!ok) {
        return res.status(401).json({ error: 'Password required to re-configure active TOTP' });
      }
    }

    const secret = generateSecret();
    await getPool().query(
      'UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2',
      [secret, req.user.id]
    );
    return res.json({ secret, otpauth_url: otpauthUrl(secret, req.user.email) });
  } catch (error) {
    logger.error({ err: error }, 'TOTP setup error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/enable { code } — verifies and returns recovery codes.
router.post('/totp/enable', requireRole(), async (req, res) => {
  try {
    const { code } = req.body || {};
    const { rows } = await getPool().query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.totp_secret) {
      return res.status(400).json({ error: 'Run TOTP setup first' });
    }
    if (!verifyTotp(rows[0].totp_secret, code)) {
      return res.status(400).json({ error: 'Invalid TOTP code' });
    }

    const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    await getPool().query('DELETE FROM recovery_codes WHERE user_id = $1', [req.user.id]);
    for (const rc of recoveryCodes) {
      await getPool().query(
        'INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), req.user.id, await argon2.hash(rc)]
      );
    }
    await getPool().query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
    return res.json({ enabled: true, recovery_codes: recoveryCodes });
  } catch (error) {
    logger.error({ err: error }, 'TOTP enable error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/disable { password }
router.post('/totp/disable', requireRole(), async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await argon2.verify(rows[0].password_hash, String(req.body?.password || '')).catch(() => false);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    await getPool().query(
      'UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1',
      [req.user.id]
    );
    await getPool().query('DELETE FROM recovery_codes WHERE user_id = $1', [req.user.id]);
    return res.json({ enabled: false });
  } catch (error) {
    logger.error({ err: error }, 'TOTP disable error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
