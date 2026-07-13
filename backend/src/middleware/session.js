const crypto = require('crypto');
const { getPool } = require('../database');

const SESSION_COOKIE = 'clomp_session';
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || '12');

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Resolve the session cookie into req.user ({ id, tenant_id, email, name, role }).
 * Does not reject on its own — pair with requireRole.
 */
async function attachSession(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return next();

    const { rows } = await getPool().query(
      `SELECT u.id, u.tenant_id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled = false`,
      [hashToken(token)]
    );
    if (rows.length) {
      req.user = rows[0];
      req.sessionToken = token;
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Require a logged-in user with one of the given roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    return next();
  };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  await getPool().query(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [crypto.randomUUID(), userId, hashToken(token), expiresAt.toISOString()]
  );
  return { token, expiresAt };
}

async function destroySession(token) {
  await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${expiresAt.toUTCString()}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

module.exports = {
  SESSION_COOKIE,
  attachSession,
  requireRole,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  hashToken
};
