const logger = require('./logger');

// PostgreSQL is the only supported database.
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let defaultTenantId = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'auditor')),
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS passkeys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id UUID PRIMARY KEY,
  user_id UUID,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sequence BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  actor JSONB NOT NULL,
  action TEXT NOT NULL,
  target JSONB,
  context JSONB,
  evidence JSONB,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_seq ON events(tenant_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_action ON events(action);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sequence BIGINT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  public_key TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant ON checkpoints(tenant_id, sequence);

CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  action TEXT NOT NULL,
  title TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days >= 0 AND grace_days <= 365),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, action)
);

CREATE TABLE IF NOT EXISTS evidence_files (
  sha256 TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size BIGINT NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement at the database level: the audit chain must never
-- be updated or deleted, no matter which code path (or operator) tries.
CREATE OR REPLACE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only ON events;
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();
`;

/**
 * Initialize the database: connect, create schema, ensure the default tenant.
 */
async function initDatabase() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required (PostgreSQL connection string)');
  }

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const client = await pool.connect();
    logger.info({ url: DATABASE_URL.replace(/:[^:@]*@/, ':***@') }, 'Connected to PostgreSQL');
    try {
      await client.query(SCHEMA);

      // Self-hosted MVP: one organization per installation. The tenants table
      // exists from day one so multi-tenant operation needs no migration.
      const tenantName = process.env.TENANT_NAME || 'default';
      const { randomUUID } = require('crypto');
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [randomUUID(), tenantName]
      );
      const res = await client.query('SELECT id FROM tenants WHERE name = $1', [tenantName]);
      defaultTenantId = res.rows[0].id;

      logger.info({ tenant: tenantName }, 'Schema initialized');
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize PostgreSQL');
    throw err;
  }
}

function getPool() {
  if (!pool) {
    throw new Error('PostgreSQL pool is not initialized. Call initDatabase() first');
  }
  return pool;
}

function getDefaultTenantId() {
  if (!defaultTenantId) {
    throw new Error('Database is not initialized. Call initDatabase() first');
  }
  return defaultTenantId;
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    defaultTenantId = null;
    logger.info('PostgreSQL connection pool closed');
  }
}

module.exports = {
  initDatabase,
  getPool,
  getDefaultTenantId,
  closeDatabase
};
