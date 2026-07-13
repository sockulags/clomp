const crypto = require('crypto');
const { getPool } = require('../database');

const KEY_PREFIX = 'clomp_live_';

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}

/**
 * Resolve X-API-Key into req.apiKey ({ id, tenant_id, name }).
 * Keys are stored hashed; a leaked database does not leak usable keys.
 * Does not reject on its own — pair with requireAuth in routes.
 */
async function attachApiKey(req, res, next) {
  try {
    const key = req.headers['x-api-key'];
    if (!key || typeof key !== 'string') return next();

    const { rows } = await getPool().query(
      'SELECT id, tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hashKey(key)]
    );
    if (rows.length) {
      req.apiKey = rows[0];
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
