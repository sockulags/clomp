const crypto = require('crypto');
const { getPool } = require('../database');
const logger = require('../logger');

const KEY_PREFIX = 'clomp_live_';

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}

// last_used_at is refreshed at most once per key per this interval, so busy
// keys do not cause a write per request.
const LAST_USED_THROTTLE_MS = 60 * 1000;

/**
 * Resolve X-API-Key into req.apiKey ({ id, tenant_id, name }).
 * Keys are stored hashed; a leaked database does not leak usable keys.
 * Expired keys (expires_at in the past) are rejected exactly like revoked ones.
 * Does not reject on its own — pair with requireAuth in routes.
 */
async function attachApiKey(req, res, next) {
  try {
    const key = req.headers['x-api-key'];
    if (!key || typeof key !== 'string') return next();

    const { rows } = await getPool().query(
      `SELECT id, tenant_id, name, last_used_at FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [hashKey(key)]
    );
    if (rows.length) {
      const { id, tenant_id, name, last_used_at } = rows[0];
      req.apiKey = { id, tenant_id, name };

      // Throttled usage tracking, fire-and-forget like sessions: it must
      // never block or break authentication. The JS check skips the round
      // trip on the common path; the WHERE clause repeats it so concurrent
      // requests (or multiple app instances) still write at most about once
      // per interval.
      if (!last_used_at || Date.now() - new Date(last_used_at).getTime() >= LAST_USED_THROTTLE_MS) {
        getPool().query(
          `UPDATE api_keys SET last_used_at = now()
           WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - ($2 * interval '1 millisecond'))`,
          [id, LAST_USED_THROTTLE_MS]
        ).catch((err) => logger.warn({ err, keyId: id }, 'Failed to update api_keys.last_used_at'));
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Require either a session user or a valid API key.
 * `roles` applies to session users only; API keys are machine writers/readers
 * scoped to their tenant.
 */
function requireAuth(...roles) {
  return (req, res, next) => {
    if (req.apiKey) return next();
    if (req.user) {
      if (roles.length && !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient role' });
      }
      return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
  };
}

/** The tenant the request acts on (session user's or API key's). */
function requestTenantId(req) {
  if (req.apiKey) return req.apiKey.tenant_id;
  if (req.user) return req.user.tenant_id;
  return null;
}

module.exports = { KEY_PREFIX, hashKey, generateApiKey, attachApiKey, requireAuth, requestTenantId };
