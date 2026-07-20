const express = require('express');
const crypto = require('crypto');
const argon2 = require('argon2');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { getPool } = require('../database');
const { createSession, setSessionCookie, requireRole } = require('../middleware/session');
const logger = require('../logger');

const router = express.Router();

/**
 * Passkeys (WebAuthn) — opt-in via WEBAUTHN_ORIGIN.
 *
 * WebAuthn requires a secure context and a stable domain, which intranet
 * installs reached over plain IP don't have — exactly why passwords + TOTP
 * remain the baseline and passkeys are configuration:
 *
 *   WEBAUTHN_ORIGIN=https://clomp.example.com   (the exact browser origin)
 *   WEBAUTHN_RP_ID=clomp.example.com            (optional, defaults to hostname)
 *
 * A passkey login satisfies MFA on its own (user verification is built in),
 * so it bypasses the TOTP prompt. Registering a new passkey requires the
 * account password — a hijacked session must not be able to mint itself a
 * durable credential.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function config() {
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (!origin) return null;
  let rpID = process.env.WEBAUTHN_RP_ID;
  if (!rpID) {
    try {
      rpID = new URL(origin).hostname;
    } catch {
      return null;
    }
  }
  return { origin, rpID, rpName: 'clomp' };
}

function requireWebAuthn(req, res, next) {
  if (!config()) {
    return res.status(501).json({ error: 'Passkeys are not configured on this instance (set WEBAUTHN_ORIGIN)' });
  }
  return next();
}

async function storeChallenge(userId, challenge, type) {
  const id = crypto.randomUUID();
  const pool = getPool();
  // Lazy cleanup keeps the table from accumulating abandoned ceremonies.
  await pool.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  await pool.query(
    'INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [id, userId, challenge, type, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()]
  );
  return id;
}

async function consumeChallenge(id, type) {
  const { rows } = await getPool().query(
    'DELETE FROM webauthn_challenges WHERE id = $1 AND type = $2 AND expires_at > now() RETURNING user_id, challenge',
    [id, type]
  );
  return rows[0] || null;
}

// GET /api/auth/passkeys/config — lets the login screen show the button only
// when the instance actually supports passkeys. Public by design.
router.get('/config', (req, res) => {
  res.json({ enabled: Boolean(config()) });
});

// GET /api/auth/passkeys — the signed-in user's registered passkeys.
router.get('/', requireRole(), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    res.json({ passkeys: rows });
  } catch (error) {
    logger.error({ err: error }, 'Error listing passkeys');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/passkeys/register/options { password }
router.post('/register/options', requireWebAuthn, requireRole(), async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await argon2.verify(rows[0].password_hash, String(req.body?.password || '')).catch(() => false);
    if (!ok) {
      return res.status(401).json({ error: 'Password required to register a passkey' });
    }

    const { rows: existing } = await getPool().query(
      'SELECT credential_id, transports FROM passkeys WHERE user_id = $1',
      [req.user.id]
    );

    const { rpName, rpID } = config();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: Buffer.from(req.user.id, 'utf8'),
      userName: req.user.email,
      userDisplayName: req.user.name,
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({
        id: c.credential_id,
        transports: c.transports ? c.transports.split(',') : undefined
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
    });

    const challengeId = await storeChallenge(req.user.id, options.challenge, 'registration');
    res.json({ options, challenge_id: challengeId });
  } catch (error) {
    logger.error({ err: error }, 'Error generating registration options');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/passkeys/register/verify { challenge_id, response, name? }
router.post('/register/verify', requireWebAuthn, requireRole(), async (req, res) => {
  try {
    const { challenge_id, response, name } = req.body || {};
    const stored = await consumeChallenge(challenge_id, 'registration');
    if (!stored || stored.user_id !== req.user.id) {
      return res.status(400).json({ error: 'Unknown or expired challenge — start again' });
    }

    const { origin, rpID } = config();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false
      });
    } catch (err) {
      return res.status(400).json({ error: `Registration failed: ${err.message}` });
    }
    if (!verification.verified) {
      return res.status(400).json({ error: 'Registration could not be verified' });
    }

    const { credential } = verification.registrationInfo;
    await getPool().query(
      `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(), req.user.id, credential.id,
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        credential.transports ? credential.transports.join(',') : null,
        typeof name === 'string' && name.length <= 100 ? name : null
      ]
    );
    res.status(201).json({ registered: true });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This passkey is already registered' });
    }
    logger.error({ err: error }, 'Error verifying registration');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/passkeys/:id
router.delete('/:id', requireRole(), async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM passkeys WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Passkey not found' });
    res.json({ removed: true });
  } catch (error) {
    logger.error({ err: error }, 'Error removing passkey');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/passkeys/login/options { email? }
// Always answers with options (empty allowCredentials for unknown emails)
// so the endpoint does not reveal which emails exist.
router.post('/login/options', requireWebAuthn, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase();
    let allowCredentials = [];
    let userId = null;

    if (email) {
      // Like password login, a soft-deactivated tenant's accounts do not
      // resolve (and their credentials are not enumerated).
      const { rows } = await getPool().query(
        `SELECT p.credential_id, p.transports, u.id AS user_id
         FROM passkeys p
         JOIN users u ON u.id = p.user_id
         JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = $1 AND u.disabled = false AND t.active = true`,
        [email]
      );
      allowCredentials = rows.map(r => ({
        id: r.credential_id,
        transports: r.transports ? r.transports.split(',') : undefined
      }));
      userId = rows[0]?.user_id || null;
    }

    const { rpID } = config();
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred'
    });

    const challengeId = await storeChallenge(userId, options.challenge, 'authentication');
    res.json({ options, challenge_id: challengeId });
  } catch (error) {
    logger.error({ err: error }, 'Error generating authentication options');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/passkeys/login/verify { challenge_id, response }
router.post('/login/verify', requireWebAuthn, async (req, res) => {
  try {
    const { challenge_id, response } = req.body || {};
    const stored = await consumeChallenge(challenge_id, 'authentication');
    if (!stored) {
      return res.status(400).json({ error: 'Unknown or expired challenge — start again' });
    }

    // The tenants join keeps passkey login consistent with password login:
    // a soft-deactivated tenant's passkeys are unknown, no session is minted.
    const { rows } = await getPool().query(
      `SELECT p.id, p.user_id, p.credential_id, p.public_key, p.counter, p.transports,
              u.email, u.name, u.role, u.disabled
       FROM passkeys p
       JOIN users u ON u.id = p.user_id
       JOIN tenants t ON t.id = u.tenant_id
       WHERE p.credential_id = $1 AND t.active = true`,
      [String(response?.id || '')]
    );
    const passkey = rows[0];
    if (!passkey || passkey.disabled) {
      return res.status(401).json({ error: 'Unknown passkey' });
    }
    // A challenge issued for a specific email must not authenticate a
    // different account's credential.
    if (stored.user_id && stored.user_id !== passkey.user_id) {
      return res.status(401).json({ error: 'Unknown passkey' });
    }

    const { origin, rpID } = config();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: passkey.credential_id,
          publicKey: Buffer.from(passkey.public_key, 'base64url'),
          counter: Number(passkey.counter),
          transports: passkey.transports ? passkey.transports.split(',') : undefined
        }
      });
    } catch (err) {
      return res.status(401).json({ error: `Authentication failed: ${err.message}` });
    }
    if (!verification.verified) {
      return res.status(401).json({ error: 'Authentication could not be verified' });
    }

    await getPool().query(
      'UPDATE passkeys SET counter = $1, last_used_at = now() WHERE id = $2',
      [verification.authenticationInfo.newCounter, passkey.id]
    );

    const { token, expiresAt } = await createSession(passkey.user_id, req.headers['user-agent']);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: { id: passkey.user_id, email: passkey.email, name: passkey.name, role: passkey.role } });
  } catch (error) {
    logger.error({ err: error }, 'Error verifying authentication');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
