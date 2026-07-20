/**
 * Seeded action catalog, tagged with the SOC 2 trust-services criteria and
 * NIS2 articles each activity type gives evidence for. Unknown actions are
 * accepted but flagged in reports.
 */
const ACTION_CATALOG = [
  { action: 'access.review.completed', title: 'Access review completed', soc2: ['CC6.1', 'CC6.2', 'CC6.3'], nis2: ['21.2(i)'] },
  { action: 'access.granted', title: 'Access granted', soc2: ['CC6.2'], nis2: ['21.2(i)'] },
  { action: 'access.revoked', title: 'Access revoked', soc2: ['CC6.3'], nis2: ['21.2(i)'] },
  { action: 'patch.applied', title: 'Patch applied', soc2: ['CC7.1'], nis2: ['21.2(e)'] },
  { action: 'vulnerability.remediated', title: 'Vulnerability remediated', soc2: ['CC7.1'], nis2: ['21.2(e)'] },
  { action: 'incident.opened', title: 'Incident opened', soc2: ['CC7.3', 'CC7.4'], nis2: ['21.2(b)', '23'] },
  { action: 'incident.resolved', title: 'Incident resolved', soc2: ['CC7.4', 'CC7.5'], nis2: ['21.2(b)', '23'] },
  { action: 'incident.reported', title: 'Incident reported to authority', soc2: ['CC7.4'], nis2: ['23'] },
  { action: 'backup.completed', title: 'Backup completed', soc2: ['A1.2'], nis2: ['21.2(c)'] },
  { action: 'backup.tested', title: 'Backup restore tested', soc2: ['A1.3'], nis2: ['21.2(c)'] },
  { action: 'training.completed', title: 'Security training completed', soc2: ['CC1.4'], nis2: ['21.2(g)'] },
  { action: 'risk.assessed', title: 'Risk assessment performed', soc2: ['CC3.2'], nis2: ['21.2(a)'] },
  { action: 'risk.decision', title: 'Risk decision recorded', soc2: ['CC3.2', 'CC5.1'], nis2: ['21.2(a)'] },
  { action: 'vendor.review', title: 'Vendor/supplier review', soc2: ['CC9.2'], nis2: ['21.2(d)'] },
  { action: 'policy.updated', title: 'Policy updated', soc2: ['CC1.3', 'CC5.3'], nis2: ['21.2(a)'] },
  { action: 'policy.approved', title: 'Policy approved', soc2: ['CC1.3'], nis2: ['21.2(a)'] },
  { action: 'crypto.key.rotated', title: 'Cryptographic key rotated', soc2: ['CC6.1'], nis2: ['21.2(h)'] },
  { action: 'pentest.completed', title: 'Penetration test completed', soc2: ['CC4.1'], nis2: ['21.2(f)'] },
  { action: 'audit.internal.completed', title: 'Internal audit completed', soc2: ['CC4.1'], nis2: ['21.2(f)'] },
  { action: 'continuity.tested', title: 'Business continuity plan tested', soc2: ['A1.3'], nis2: ['21.2(c)'] },
  { action: 'mfa.enforced', title: 'MFA enforcement verified', soc2: ['CC6.1'], nis2: ['21.2(j)'] },
  // Changes to the control plan itself are chain events too: an auditor can
  // see when a scheduled control was added, relaxed or removed.
  { action: 'control.schedule.created', title: 'Scheduled control created', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
  { action: 'control.schedule.updated', title: 'Scheduled control updated', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
  { action: 'control.schedule.removed', title: 'Scheduled control removed', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
  { action: 'retention.pruned', title: 'Retention pruning performed', soc2: ['CC6.5'], nis2: ['21.2(a)'] },
  // Tenant roster changes are chain events too, but only occur in
  // multi-tenant mode — keeping them out of the catalog otherwise keeps
  // flag-off behavior identical to a single-tenant install.
  ...(process.env.MULTI_TENANT === 'true' ? [
    { action: 'tenant.created', title: 'Tenant created', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
    { action: 'tenant.renamed', title: 'Tenant renamed', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
    { action: 'tenant.deactivated', title: 'Tenant deactivated', soc2: ['CC5.1'], nis2: ['21.2(a)'] },
    { action: 'tenant.reactivated', title: 'Tenant reactivated', soc2: ['CC5.1'], nis2: ['21.2(a)'] }
  ] : [])
];

const byAction = new Map(ACTION_CATALOG.map(a => [a.action, a]));

function isKnownAction(action) {
  return byAction.has(action);
}

function getAction(action) {
  return byAction.get(action) || null;
}

/** Actions must be namespaced, lowercase dot-separated segments. */
const ACTION_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

function isValidActionFormat(action) {
  return typeof action === 'string' && action.length <= 200 && ACTION_PATTERN.test(action);
}

module.exports = { ACTION_CATALOG, isKnownAction, getAction, isValidActionFormat };
