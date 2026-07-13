const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { getPool } = require('../database');
const { requireAuth } = require('../middleware/apikey');
const logger = require('../logger');

const router = express.Router();

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(__dirname, '../../data/evidence');
const MAX_EVIDENCE_BYTES = parseInt(process.env.MAX_EVIDENCE_BYTES || String(25 * 1024 * 1024)); // 25MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 }
});

function evidencePath(sha256) {
  // Two-level fanout so a busy instance doesn't end up with one huge directory.
  return path.join(EVIDENCE_DIR, sha256.slice(0, 2), sha256);
}

// POST /api/evidence — upload a file; returns { sha256, filename, size } to
// embed in an event's evidence array. Content-addressed: the same bytes are
// stored once no matter how many events reference them.
router.post('/', requireAuth('admin', 'editor'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file field is required (multipart/form-data)' });

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const target = evidencePath(sha256);

    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, req.file.buffer);
    }

    const uploadedBy = req.user ? req.user.email : `api_key:${req.apiKey.name}`;
    await getPool().query(
      `INSERT INTO evidence_files (sha256, filename, size, content_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256) DO NOTHING`,
      [sha256, req.file.originalname, req.file.size, req.file.mimetype, uploadedBy]
    );

    res.status(201).json({ sha256, filename: req.file.originalname, size: req.file.size });
  } catch (error) {
    logger.error({ err: error }, 'Error uploading evidence');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/evidence/:sha256 — download; auditors included.
router.get('/:sha256', requireAuth(), async (req, res) => {
  try {
    const sha256 = String(req.params.sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      return res.status(400).json({ error: 'Invalid sha256' });
    }
    const { rows } = await getPool().query('SELECT filename, content_type FROM evidence_files WHERE sha256 = $1', [sha256]);
    const file = evidencePath(sha256);
    if (!rows.length || !fs.existsSync(file)) {
      return res.status(404).json({ error: 'Evidence not found' });
    }
    res.setHeader('Content-Type', rows[0].content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rows[0].filename)}"`);
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    logger.error({ err: error }, 'Error downloading evidence');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
