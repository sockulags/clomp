#!/usr/bin/env node
/**
 * Create the first admin user, or reset an existing user's password and MFA.
 * This is also the break-glass recovery path for a locked-out admin: it runs
 * against the database directly, no HTTP or session involved.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/create-admin.js <email> [name] [--tenant <slug>]
 *
 * Prints a generated one-time password. If a user with the email exists, the
 * password is reset, TOTP disabled and all sessions revoked instead.
 *
 * --tenant <slug> targets that tenant (multi-tenant mode), creating the
 * tenant first if it does not exist and reactivating it if it was
 * soft-deactivated (this script is the break-glass path — a printed one-time
 * password must actually work). Without the flag the default tenant is used,
 * exactly as before.
 */

const crypto = require('crypto');
require('dotenv').config();

/**
 * Create an admin user with the given password, or reset an existing user to
 * it (admin role, TOTP off, all sessions and recovery codes revoked).
 * Assumes initDatabase() has already run. Targets tenantId when given,
 * otherwise the default tenant. Returns { created, email }.
 * Throws if the email already exists in a different tenant than the one
 * targeted — emails are unique per installation.
 */
async function upsertAdmin(email, name, password, tenantId = null) {
  const argon2 = require('argon2');
  const { getPool, getDefaultTenantId } = require('../src/database');

  const pool = getPool();
  const targetTenantId = tenantId || getDefaultTenantId();
  const passwordHash = await argon2.hash(password);
  const normalizedEmail = String(email).toLowerCase();

  const existing = await pool.query('SELECT id, tenant_id FROM users WHERE email = $1', [normalizedEmail]);

  if (existing.rows.length) {
    if (tenantId && existing.rows[0].tenant_id !== targetTenantId) {
      throw new Error(`${normalizedEmail} already exists in another tenant — emails are unique per installation`);
    }
    const userId = existing.rows[0].id;
    await pool.query(
      `UPDATE users SET password_hash = $1, totp_enabled = false, totp_secret = NULL, disabled = false, role = 'admin'
       WHERE id = $2`,
      [passwordHash, userId]
    );
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    return { created: false, email: normalizedEmail };
  }

  await pool.query(
    `INSERT INTO users (id, tenant_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'admin')`,
    [crypto.randomUUID(), targetTenantId, normalizedEmail, name || normalizedEmail, passwordHash]
  );
  return { created: true, email: normalizedEmail };
}

function parseArgs(argv) {
  const positional = [];
  let tenantSlug = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') {
      tenantSlug = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { email: positional[0], name: positional[1], tenantSlug };
}

async function main() {
  const { email, name, tenantSlug } = parseArgs(process.argv.slice(2));
  const { initDatabase, getPool, closeDatabase, TENANT_SLUG_PATTERN } =
    require('../src/database');
  if (!email || (tenantSlug !== null && !TENANT_SLUG_PATTERN.test(tenantSlug || ''))) {
    console.error('Usage: node scripts/create-admin.js <email> [name] [--tenant <slug>]');
    console.error('       --tenant takes a lowercase slug (letters, digits, hyphens)');
    process.exit(1);
  }

  await initDatabase();
  const pool = getPool();

  let tenantId = null;
  if (tenantSlug) {
    // Race-free find-or-create, same idiom as initDatabase's default tenant.
    const inserted = await pool.query(
      `INSERT INTO tenants (id, name, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), tenantSlug, tenantSlug]
    );
    if (inserted.rows.length) {
      console.log(`\n➕ Created tenant "${tenantSlug}"`);
    }
    const found = await pool.query('SELECT id, active FROM tenants WHERE name = $1', [tenantSlug]);
    tenantId = found.rows[0].id;
    // Break-glass: a printed one-time password must actually work, so an
    // explicitly targeted deactivated tenant is reactivated.
    if (found.rows[0].active === false) {
      await pool.query('UPDATE tenants SET active = true WHERE id = $1', [tenantId]);
      console.log(`\n♻️  Reactivated tenant "${tenantSlug}" (it was soft-deactivated; logins work again)`);
    }
  }

  const password = crypto.randomBytes(12).toString('base64url');
  const { created, email: normalizedEmail } = await upsertAdmin(email, name, password, tenantId);

  if (created) {
    console.log(`\n✅ Created admin user ${normalizedEmail}${tenantSlug ? ` in tenant "${tenantSlug}"` : ''}`);
  } else {
    console.log(`\n♻️  Reset existing user ${normalizedEmail} (admin, TOTP off, sessions revoked)`);
  }

  console.log(`\n   One-time password: ${password}`);
  console.log('   Log in and change it, then enable TOTP under your profile.\n');

  await closeDatabase();
}

module.exports = { upsertAdmin };

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
}
