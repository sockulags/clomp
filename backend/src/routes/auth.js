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

    const { rows } = await getPool().query(
      'SELECT id, email, name, role, password_hash, totp_secret, totp_enabled, disabled FROM users WHERE email = $1',
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

    const { token, expiresAt } = await createSession(user.id);
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

// POST /api/auth/totp/setup — generate a secret; enable with a valid code.
router.post('/totp/setup', requireRole(), async (req, res) => {
  try {
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
