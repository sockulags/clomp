#!/usr/bin/env node
/**
 * Development Setup Script
 *
 * Creates a test service with API key for local development.
 * DO NOT use in production!
 *
 * Requires a running PostgreSQL and DATABASE_URL set, e.g.:
 *   DATABASE_URL=postgresql://loggplattform:password@localhost:5432/loggplattform
 *
 * Usage: node scripts/setup-dev.js
 */

const crypto = require('crypto');
const { initDatabase, getPool, closeDatabase } = require('../src/database');

console.log('🔧 Development Setup Script');
console.log('===========================\n');

async function main() {
  await initDatabase();

  const testServiceId = 'dev-test-service';
  const testServiceName = 'dev-service';
  const testApiKey = 'dev-api-key-' + crypto.randomBytes(16).toString('hex');

  await getPool().query(
    `INSERT INTO services (id, name, api_key) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET api_key = EXCLUDED.api_key`,
    [testServiceId, testServiceName, testApiKey]
  );

  console.log('\n✅ Development service created:\n');
  console.log('   Service Name: ' + testServiceName);
  console.log('   API Key:      ' + testApiKey);
  console.log('\n📝 Add to your .env file:');
  console.log(`   LOGGPLATTFORM_API_KEY=${testApiKey}`);
  console.log('\n⚠️  WARNING: This is for development only. Never use in production!\n');

  await closeDatabase();
}

main().catch((err) => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
