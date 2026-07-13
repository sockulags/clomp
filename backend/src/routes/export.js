const express = require('express');
const PDFDocument = require('pdfkit');
const { getPool } = require('../database');
const { rowToEvent, verifyChain } = require('../services/chain');
const { requireAuth, requestTenantId } = require('../middleware/apikey');
const { getAction } = require('../actions');
const logger = require('../logger');

const router = express.Router();

async function fetchEvents(tenantId, from, to) {
  const conditions = ['tenant_id = $1'];
  const params = [tenantId];
  if (from) {
    params.push(new Date(from).toISOString());
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to).toISOString());
    conditions.push(`occurred_at <= $${params.length}`);
  }
  const { rows } = await getPool().query(
    `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC`,
    params
  );
  return rows.map(rowToEvent);
}

async function fetchCheckpoints(tenantId) {
  const { rows } = await getPool().query(
    `SELECT tenant_id, sequence, hash, signature, public_key, signed_at
     FROM checkpoints WHERE tenant_id = $1 ORDER BY signed_at ASC`,
    [tenantId]
  );
  return rows.map(cp => ({
    tenant_id: cp.tenant_id,
    sequence: Number(cp.sequence),
    hash: cp.hash,
    signature: cp.signature,
    public_key: cp.public_key,
    signed_at: new Date(cp.signed_at).toISOString()
  }));
}

// GET /api/export/jsonl?from=&to= — offline-verifiable JSONL export.
// Line types: {type:"event",...}, {type:"checkpoint",...}. Verify with
// scripts/verify-export.js without any access to this server.
router.get('/jsonl', requireAuth(), async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const events = await fetchEvents(tenantId, req.query.from, req.query.to);
    const checkpoints = await fetchCheckpoints(tenantId);

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="clomp-export-${new Date().toISOString().slice(0, 10)}.jsonl"`);

    for (const event of events) {
      res.write(JSON.stringify({ type: 'event', ...event }) + '\n');
    }
    for (const cp of checkpoints) {
      res.write(JSON.stringify({ type: 'checkpoint', ...cp }) + '\n');
    }
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting JSONL');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/report?from=&to= — audit-ready PDF report.
router.get('/report', requireAuth(), async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { from, to } = req.query;
    const events = await fetchEvents(tenantId, from, to);
    const verification = await verifyChain(tenantId);
    const { rows: cpRows } = await getPool().query(
      'SELECT sequence, signed_at FROM checkpoints WHERE tenant_id = $1 ORDER BY signed_at DESC LIMIT 1',
      [tenantId]
    );

    // Aggregate per action, mapped to frameworks.
    const perAction = new Map();
    let unknownActions = 0;
    for (const event of events) {
      const entry = perAction.get(event.action) || { count: 0, catalog: getAction(event.action) };
      entry.count++;
      perAction.set(event.action, entry);
      if (!entry.catalog) unknownActions++;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="clomp-report-${new Date().toISOString().slice(0, 10)}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    doc.pipe(res);

    const ink = '#1a1d21';
    const muted = '#6b7280';
    const accent = '#0f6b54';

    // Title block
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(24).text('clomp', { continued: true })
      .font('Helvetica').fillColor(muted).text('  ·  security activity report');
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor(muted)
      .text(`Period: ${from ? new Date(from).toISOString().slice(0, 10) : 'beginning'} — ${to ? new Date(to).toISOString().slice(0, 10) : 'now'}`)
      .text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown(0.5);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(accent).lineWidth(2).stroke();
    doc.moveDown(1);

    // Integrity statement
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text('Chain integrity');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor(ink);
    if (verification.intact) {
      doc.fillColor(accent).text(`✔ INTACT — ${verification.verified} events verified against the hash chain.`);
    } else {
      doc.fillColor('#b91c1c').text(`✘ BROKEN at sequence ${verification.firstBreak} (${verification.reason}). ${verification.verified} events verified before the break.`);
    }
    doc.fillColor(muted);
    if (cpRows.length) {
      doc.text(`Latest signed checkpoint: sequence ${cpRows[0].sequence}, signed ${new Date(cpRows[0].signed_at).toISOString()}.`);
    } else {
      doc.text('No signed checkpoint exists yet.');
    }
    doc.moveDown(1);

    // Summary per activity type
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text('Activity summary');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    if (!perAction.size) {
      doc.fillColor(muted).text('No events in the selected period.');
    }
    for (const [action, { count, catalog }] of [...perAction.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const frameworks = catalog
        ? `SOC 2: ${catalog.soc2.join(', ')} · NIS2: ${catalog.nis2.join(', ')}`
        : 'not in catalog — review manually';
      doc.fillColor(ink).font('Helvetica-Bold').text(`${action}`, { continued: true })
        .font('Helvetica').fillColor(muted).text(`  ×${count}   ${frameworks}`);
    }
    if (unknownActions > 0) {
      doc.moveDown(0.3);
      doc.fillColor('#b45309').text(`⚠ ${unknownActions} event(s) use actions outside the seeded catalog.`);
    }
    doc.moveDown(1);

    // Event list
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(`Events (${events.length})`);
    doc.moveDown(0.3);
    for (const event of events) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink)
        .text(`#${event.sequence}  ${event.action}`, { continued: true })
        .font('Helvetica').fillColor(muted)
        .text(`  ${event.occurred_at}`);
      doc.font('Helvetica').fontSize(8).fillColor(muted)
        .text(`actor: ${event.actor?.type}/${event.actor?.id}` +
          (event.target ? `   target: ${event.target.type || ''}/${event.target.id || ''}` : '') +
          (Array.isArray(event.evidence) && event.evidence.length ? `   evidence: ${event.evidence.length} file(s)` : ''));
      doc.fontSize(7).fillColor('#9ca3af').text(`hash ${event.hash}`);
      doc.moveDown(0.35);
    }

    // Evidence appendix
    const withEvidence = events.filter(e => Array.isArray(e.evidence) && e.evidence.length);
    if (withEvidence.length) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text('Evidence appendix');
      doc.moveDown(0.3);
      for (const event of withEvidence) {
        for (const item of event.evidence) {
          if (doc.y > doc.page.height - 90) doc.addPage();
          doc.font('Helvetica').fontSize(8).fillColor(ink)
            .text(`#${event.sequence}  ${item.filename || '(unnamed)'} — ${item.size ?? '?'} bytes`);
          doc.fontSize(7).fillColor('#9ca3af').text(`sha256 ${item.sha256}`);
          doc.moveDown(0.25);
        }
      }
    }

    doc.end();
  } catch (error) {
    logger.error({ err: error }, 'Error generating PDF report');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
