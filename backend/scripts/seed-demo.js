#!/usr/bin/env node
/**
 * Seed realistic demo data: ~6 months of security activity for a small
 * organization, scheduled controls (one deliberately overdue), and a signed
 * checkpoint. Intended for screenshots, demos and trying out the UI.
 *
 *   DATABASE_URL=postgresql://... node scripts/seed-demo.js
 *
 * Do not run against a production installation: it appends demo events to
 * the chain (they can only be removed by retention pruning).
 */

const { randomUUID } = require('crypto');
require('dotenv').config();

const { initDatabase, getPool, getDefaultTenantId, closeDatabase } = require('../src/database');
const { appendEvent } = require('../src/services/chain');
const { createCheckpoint } = require('../src/services/checkpoints');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = d => new Date(now - d * DAY).toISOString();

// occurred_at is backdated (backfill is a feature); recorded_at stays "now".
const EVENTS = [
  { d: 175, action: 'policy.approved', actor: { type: 'user', id: 'anna@demo.example' }, target: { type: 'policy', id: 'information-security-policy', name: 'Information Security Policy v3' } },
  { d: 170, action: 'training.completed', actor: { type: 'user', id: 'anna@demo.example' }, target: { type: 'group', id: 'all-staff' }, context: { participants: 28, provider: 'SecAware' } },
  { d: 168, action: 'access.review.completed', actor: { type: 'user', id: 'johan@demo.example' }, target: { type: 'scope', id: 'production' }, context: { reviewed_accounts: 41, revoked: 3 } },
  { d: 150, action: 'backup.tested', actor: { type: 'user', id: 'ops@demo.example' }, target: { type: 'system', id: 'primary-db' }, context: { restore_time_minutes: 22, result: 'pass' } },
  { d: 140, action: 'patch.applied', actor: { type: 'service', id: 'ansible' }, target: { type: 'system', id: 'web-01' }, context: { cve: 'CVE-2026-1123' } },
  { d: 139, action: 'patch.applied', actor: { type: 'service', id: 'ansible' }, target: { type: 'system', id: 'web-02' }, context: { cve: 'CVE-2026-1123' } },
  { d: 120, action: 'vendor.review', actor: { type: 'user', id: 'anna@demo.example' }, target: { type: 'vendor', id: 'cloudhost-eu' }, context: { dpa_current: true, subprocessors_reviewed: true } },
  { d: 112, action: 'incident.opened', actor: { type: 'user', id: 'ops@demo.example' }, target: { type: 'incident', id: 'INC-2026-007', name: 'Phishing mail to finance' }, context: { severity: 'medium' } },
  { d: 111, action: 'incident.resolved', actor: { type: 'user', id: 'ops@demo.example' }, target: { type: 'incident', id: 'INC-2026-007' }, context: { root_cause: 'credential phishing, no compromise confirmed', duration_hours: 26 } },
  { d: 98, action: 'risk.assessed', actor: { type: 'user', id: 'anna@demo.example' }, target: { type: 'scope', id: 'annual-2026' }, context: { risks_identified: 14, high: 2 } },
  { d: 97, action: 'risk.decision', actor: { type: 'user', id: 'ceo@demo.example' }, target: { type: 'risk', id: 'R-2026-03', name: 'Single region hosting' }, context: { decision: 'accept until 2027 budget' } },
  { d: 90, action: 'access.review.completed', actor: { type: 'user', id: 'johan@demo.example' }, target: { type: 'scope', id: 'production' }, context: { reviewed_accounts: 43, revoked: 1 } },
  { d: 75, action: 'backup.tested', actor: { type: 'user', id: 'ops@demo.example' }, target: { type: 'system', id: 'primary-db' }, context: { restore_time_minutes: 19, result: 'pass' } },
  { d: 61, action: 'crypto.key.rotated', actor: { type: 'service', id: 'vault' }, target: { type: 'key', id: 'jwt-signing' } },
  { d: 55, action: 'patch.applied', actor: { type: 'service', id: 'ansible' }, target: { type: 'system', id: 'db-01' }, context: { package: 'postgresql-16' } },
  { d: 42, action: 'mfa.enforced', actor: { type: 'user', id: 'johan@demo.example' }, target: { type: 'scope', id: 'admin-accounts' }, context: { coverage: '100%' } },
  { d: 30, action: 'access.granted', actor: { type: 'user', id: 'johan@demo.example' }, target: { type: 'user', id: 'new-hire-7' }, context: { role: 'developer', approver: 'anna@demo.example' } },
  { d: 14, action: 'backup.tested', actor: { type: 'user', id: 'ops@demo.example' }, target: { type: 'system', id: 'primary-db' }, context: { restore_time_minutes: 21, result: 'pass' } },
  { d: 7, action: 'access.review.completed', actor: { type: 'user', id: 'johan@demo.example' }, target: { type: 'scope', id: 'production' }, context: { reviewed_accounts: 44, revoked: 2 } },
  { d: 2, action: 'patch.applied', actor: { type: 'service', id: 'ansible' }, target: { type: 'system', id: 'web-01' }, context: { cve: 'CVE-2026-4410' } }
];

// (action, title, frequency, grace, created_days_ago) — the vulnerability
// schedule is deliberately overdue: monthly, created 100 days ago, never logged.
const SCHEDULES = [
  ['access.review.completed', 'Quarterly access review', 'quarterly', 14, 170],
  ['backup.tested', 'Monthly restore test', 'monthly', 7, 160],
  ['training.completed', 'Yearly security training', 'yearly', 30, 170],
  ['vulnerability.remediated', 'Monthly vulnerability remediation', 'monthly', 7, 100]
];

async function main() {
  await initDatabase();
  const pool = getPool();
  const tenantId = getDefaultTenantId();

  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM events WHERE tenant_id = $1', [tenantId]);
  if (Number(rows[0].n) > 0) {
    console.error(`Refusing to seed: tenant already has ${rows[0].n} events (the chain is append-only).`);
    process.exit(1);
  }

  for (const { d, action, actor, target, context } of EVENTS) {
    const event = await appendEvent(tenantId, {
      occurredAt: daysAgo(d),
      actor: { ...actor, recorded_by: { via: 'seed', id: 'seed-demo' } },
      action,
      target,
      context
    });
    console.log(`#${event.sequence} ${action} (${daysAgo(d).slice(0, 10)})`);
  }

  for (const [action, title, frequency, grace, createdDaysAgo] of SCHEDULES) {
    await pool.query(
      `INSERT INTO schedules (id, tenant_id, action, title, frequency, grace_days, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, action) DO NOTHING`,
      [randomUUID(), tenantId, action, title, frequency, grace, 'seed-demo', daysAgo(createdDaysAgo)]
    );
    console.log(`schedule: ${title} (${frequency})`);
  }

  const cp = await createCheckpoint(tenantId);
  console.log(`checkpoint signed at sequence ${cp.sequence}`);

  await closeDatabase();
  console.log('\nDemo data seeded. Create a login with scripts/create-admin.js.');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
