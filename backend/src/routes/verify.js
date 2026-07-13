const express = require('express');
const { getPool } = require('../database');
const { verifyChain } = require('../services/chain');
const { verifyCheckpointSignature } = require('../services/checkpoints');
const { requireAuth, requestTenantId } = require('../middleware/apikey');
const logger = require('../logger');

const router = express.Router();

// GET /api/verify?from=&to= — recompute the hash chain over a sequence range.
router.get('/', requireAuth(), async (req, res) => {
  try {
    const from = req.query.from ? parseInt(req.query.from) : 1;
    const to = req.query.to ? parseInt(req.query.to) : null;
    if (!Number.isInteger(from) || from < 1 || (to !== null && (!Number.isInteger(to) || to < from))) {
      return res.status(400).json({ error: 'from/to must be positive integers with to >= from' });
    }

    const tenantId = requestTenantId(req);
    const result = await verifyChain(tenantId, from, to);

    // Also validate the latest checkpoint signature, if one exists.
    const { rows } = await getPool().query(
      `SELECT tenant_id, sequence, hash, signature, public_key, signed_at
       FROM checkpoints WHERE tenant_id = $1 ORDER BY signed_at DESC LIMIT 1`,
      [tenantId]
    );
    let checkpoint = null;
    if (rows.length) {
      const cp = rows[0];
      checkpoint = {
        sequence: Number(cp.sequence),
        signed_at: new Date(cp.signed_at).toISOString(),
        signature_valid: verifyCheckpointSignature({
          tenant_id: cp.tenant_id,
          sequence: Number(cp.sequence),
          hash: cp.hash,
          signed_at: new Date(cp.signed_at).toISOString(),
          signature: cp.signature,
          public_key: cp.public_key
        })
      };
    }

    res.json({ ...result, checkpoint });
  } catch (error) {
    logger.error({ err: error }, 'Error verifying chain');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
