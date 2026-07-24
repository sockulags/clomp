const fs = require('fs');
const path = require('path');

/**
 * Structural guard: every SQL statement that touches a tenant-owned table must
 * constrain it by tenant_id.
 *
 * Isolation in this codebase is enforced query by query, by hand. That worked
 * until GET /api/evidence/:sha256 shipped without a tenant predicate, which
 * let any authenticated principal download another tenant's evidence given its
 * hash. Nothing failed — there was no test that could fail, because the rule
 * only existed in reviewers' heads.
 *
 * This test makes the rule mechanical: it reads the SQL out of the route and
 * service sources and fails when a statement names a tenant-owned table but
 * never mentions tenant_id. It is deliberately blunt — it proves the predicate
 * is present, not that it is correct — but "someone forgot entirely" is the
 * failure mode that actually happened, and this catches it before review does.
 *
 * A statement that genuinely must span tenants goes in ALLOWED_CROSS_TENANT
 * with a written reason. Adding an entry should feel like a decision.
 */

const SOURCE_DIRS = [
  path.join(__dirname, '..', 'routes'),
  path.join(__dirname, '..', 'services')
];

// Tables whose rows belong to exactly one tenant.
const TENANT_OWNED_TABLES = [
  'events',
  'checkpoints',
  'evidence_files',
  'api_keys',
  'users',
  'schedules',
  'webhook_deliveries'
];

// Statements that are allowed to span tenants, each with the reason it is safe.
// Keyed by a distinctive fragment of the statement.
const ALLOWED_CROSS_TENANT = [
  {
    match: 'SELECT password_hash FROM users WHERE id = $1',
    reason:
      'Looks up the authenticated caller by their own session id (req.user.id), which cannot address another tenant.'
  }
];

// Whole sources that operate across tenants by design. These run without a
// request context, so there is no tenant to scope to — the scoping happened
// when the row was written.
const INSTANCE_WIDE_SOURCES = [
  {
    file: 'services/webhookDeliveries.js',
    reason:
      'Background delivery worker: it sweeps pending deliveries for every tenant and then updates the exact rows it selected, by primary key. No user input reaches these statements.'
  }
];

function sqlStatementsIn(source) {
  // Route/service SQL is written as quoted strings — template literals for the
  // multi-line ones, plain quotes for short lookups.
  const statements = [];
  const patterns = [/`([^`]*)`/g, /'([^']*)'/g, /"([^"]*)"/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const text = match[1];
      if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text)) {
        statements.push(text.replace(/\s+/g, ' ').trim());
      }
    }
  }
  return statements;
}

function tenantTablesTouchedBy(statement) {
  return TENANT_OWNED_TABLES.filter((table) =>
    new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i').test(statement)
  );
}

function sourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.js')) files.push(path.join(dir, name));
    }
  }
  return files;
}

describe('tenant scoping', () => {
  test('every SQL statement touching a tenant-owned table constrains tenant_id', () => {
    const violations = [];

    for (const file of sourceFiles()) {
      const relative = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
      if (INSTANCE_WIDE_SOURCES.some((entry) => entry.file === relative)) continue;

      const source = fs.readFileSync(file, 'utf8');
      // Filter builders assemble their WHERE clause from a conditions array.
      // The predicate is real, it just is not in the string literal — so trust
      // it only when the array is seeded with the tenant, never otherwise.
      const seedsTenantCondition = /conditions\s*=\s*\[\s*['"`]tenant_id/.test(source);

      for (const statement of sqlStatementsIn(source)) {
        const tables = tenantTablesTouchedBy(statement);
        if (!tables.length) continue;
        if (/tenant_id/i.test(statement)) continue;
        if (/\$\{conditions/.test(statement) && seedsTenantCondition) continue;
        if (ALLOWED_CROSS_TENANT.some((entry) => statement.includes(entry.match))) continue;

        violations.push(
          `${path.relative(path.join(__dirname, '..', '..'), file)} — touches ${tables.join(', ')} without tenant_id:\n    ${statement.slice(0, 160)}`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test('the cross-tenant exemptions stay small and explained', () => {
    for (const entry of [...ALLOWED_CROSS_TENANT, ...INSTANCE_WIDE_SOURCES]) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
    // A growing exemption list means the invariant is eroding. Raising these
    // numbers should be a conscious act, not a reflex.
    expect(ALLOWED_CROSS_TENANT.length).toBeLessThanOrEqual(3);
    expect(INSTANCE_WIDE_SOURCES.length).toBeLessThanOrEqual(2);
  });
});
