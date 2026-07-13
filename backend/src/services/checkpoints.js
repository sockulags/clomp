const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { getPool } = require('../database');
const { canonicalize } = require('../canonical');
const logger = require('../logger');

const KEY_DIR = process.env.KEY_DIR || path.join(__dirname, '../../data/keys');
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'checkpoint-ed25519.pem');
const PUBLIC_KEY_PATH = path.join(KEY_DIR, 'checkpoint-ed25519.pub.pem');

let cachedKeys = null;

/**
 * Load the instance's Ed25519 checkpoint signing keypair, generating it on
 * first use. The public key is what auditors use to verify exports offline.
 */
function ensureSigningKeys() {
  if (cachedKeys) return cachedKeys;

  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    fs.mkdirSync(KEY_DIR, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
    logger.info({ dir: KEY_DIR }, 'Generated new checkpoint signing keypair');
  }

  cachedKeys = {
    privateKey: crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH)),
    publicKeyPem: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8')
  };
  return cachedKeys;
}

/** The exact payload that is signed. Must match scripts/verify-export.js. */
function checkpointPayload({ tenant_id, sequence, hash, signed_at }) {
  return canonicalize({ tenant_id, sequence, hash, signed_at });
}

/**
 * Sign the current tip of a tenant's chain and store the checkpoint.
 * Returns null when the chain is empty.
 */
async function createCheckpoint(tenantId) {
  const pool = getPool();
  const tip = await pool.query(
    'SELECT sequence, hash FROM events WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1',
    [tenantId]
  );
  if (!tip.rows.length) return null;

  const { privateKey, publicKeyPem } = ensureSigningKeys();
  const checkpoint = {
    id: randomUUID(),
    tenant_id: tenantId,
    sequence: Number(tip.rows[0].sequence),
    hash: tip.rows[0].hash,
    signed_at: new Date().toISOString()
  };

  const signature = crypto
    .sign(null, Buffer.from(checkpointPayload(checkpoint), 'utf8'), privateKey)
    .toString('base64');

  await pool.query(
    `INSERT INTO checkpoints (id, tenant_id, sequence, hash, signature, public_key, signed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [checkpoint.id, checkpoint.tenant_id, checkpoint.sequence, checkpoint.hash,
      signature, publicKeyPem, checkpoint.signed_at]
  );

  logger.info({ tenantId, sequence: checkpoint.sequence }, 'Checkpoint created');
  return { ...checkpoint, signature, public_key: publicKeyPem };
}

/** Verify a checkpoint signature (used by tests and the verify endpoint). */
function verifyCheckpointSignature(checkpoint) {
  const publicKey = crypto.createPublicKey(checkpoint.public_key);
  return crypto.verify(
    null,
    Buffer.from(checkpointPayload(checkpoint), 'utf8'),
    publicKey,
    Buffer.from(checkpoint.signature, 'base64')
  );
}

module.exports = { ensureSigningKeys, createCheckpoint, verifyCheckpointSignature, checkpointPayload };
