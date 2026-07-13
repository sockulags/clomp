#!/usr/bin/env node
/**
 * Create the first admin user, or reset an existing user's password and MFA.
 * This is also the break-glass recovery path for a locked-out admin: it runs
 * against the database directly, no HTTP or session involved.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/create-admin.js <email> [name]
 *
 * Prints a generated one-time password. If a user with the email exists, the
 * password is reset, TOTP disabled and all sessions revoked instead.
 */

const crypto = require('crypto');
require('dotenv').config();

async function main() {
  const [email, name] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node scripts/create-admin.js <email> [name]');
    process.exit(1);
  }

  const argon2 = require('argon2');
  const { initDatabase, getPool, getDefaultTenantId, closeDatabase } = require('../src/database');

  await initDatabase();
  const pool = getPool();
  const password = crypto.randomBytes(12).toString('base64url');
  const passwordHash = await argon2.hash(password);
  const normalizedEmail = String(email).toLowerCase();

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);

  if (existing.rows.length) {
    const userId = existing.rows[0].id;
    await pool.query(
      `UPDATE users SET password_hash = $1, totp_enabled = false, totp_secret = NULL, disabled = false, role = 'admin'
       WHERE id = $2`,
      [passwordHash, userId]
    );
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    console.log(`\n♻️  Reset existing user ${normalizedEmail} (admin, TOTP off, sessions revoked)`);
  } else {
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [crypto.randomUUID(), getDefaultTenantId(), normalizedEmail, name || normalizedEmail, passwordHash]
    );
    console.log(`\n✅ Created admin user ${normalizedEmail}`);
  }

  console.log(`\n   One-time password: ${password}`);
  console.log('   Log in and change it, then enable TOTP under your profile.\n');

  await closeDatabase();
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
