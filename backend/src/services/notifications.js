const { getPool } = require('../database');
const { listWithStatus } = require('./schedules');
const logger = require('../logger');

/**
 * Overdue-control notifications (opt-in).
 *
 * Overdue scheduled controls are visible in the UI, the PDF report and the
 * CLI — but all of those require someone to look. This job pushes a daily
 * digest by email the moment looking stops happening, which is exactly when
 * controls start slipping.
 *
 * Reuses the SMTP_* settings from external anchoring; enable by setting
 * NOTIFY_EMAIL_TO. Only sends when something is overdue (or due, if
 * NOTIFY_INCLUDE_DUE=true) — no noise on green days.
 */

function config() {
  const to = process.env.NOTIFY_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  if (!to || !host) return null;
  return {
    to,
    includeDue: process.env.NOTIFY_INCLUDE_DUE === 'true',
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || 'clomp@localhost'
  };
}

function isConfigured() {
  return Boolean(config());
}

function digestBody(items) {
  const lines = ['The following scheduled security controls need attention:', ''];
  for (const s of items) {
    const last = s.last_event_at ? s.last_event_at.slice(0, 10) : 'never';
    lines.push(`  [${s.status.toUpperCase()}] ${s.title || s.action}`);
    lines.push(`    action: ${s.action} · ${s.frequency} · last logged ${last} · due ${s.next_due_at.slice(0, 10)}`);
    lines.push('');
  }
  lines.push('Record the completed activity in clomp to clear the reminder.');
  return lines.join('\n');
}

/**
 * Check every tenant's schedules and mail a digest of overdue (and
 * optionally due) controls. Returns the number of notifications sent.
 */
async function runOverdueNotificationJob() {
  const cfg = config();
  if (!cfg) return 0;

  const { rows } = await getPool().query('SELECT DISTINCT tenant_id FROM schedules');
  let sent = 0;

  for (const { tenant_id } of rows) {
    const schedules = await listWithStatus(tenant_id);
    const items = schedules.filter(s =>
      s.status === 'overdue' || (cfg.includeDue && s.status === 'due')
    );
    if (!items.length) continue;

    const overdue = items.filter(s => s.status === 'overdue').length;
    try {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined
      });
      await transport.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject: `clomp: ${overdue} scheduled control(s) overdue`,
        text: digestBody(items)
      });
      sent++;
      logger.info({ tenantId: tenant_id, overdue, to: cfg.to }, 'Overdue-control digest sent');
    } catch (err) {
      logger.error({ err, tenantId: tenant_id }, 'Failed to send overdue-control digest');
    }
  }
  return sent;
}

module.exports = { isConfigured, runOverdueNotificationJob, digestBody };
