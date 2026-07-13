const logger = require('./logger');

// PostgreSQL is the only supported database.
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;

/**
 * Thin adapter over the pg pool that exposes a callback-style API
 * (run/get/all) with SQLite-style ? placeholders, so route code can
 * use one query dialect.
 */
class DatabaseAdapter {
  /**
   * Run a query that doesn't return rows (INSERT, UPDATE, DELETE)
   */
  run(sql, params, callback) {
    const pgSql = convertPlaceholders(sql);
    getPool().query(pgSql, params)
      .then(result => {
        if (callback) callback.call({ changes: result.rowCount }, null);
      })
      .catch(err => {
        if (callback) callback(err);
      });
  }

  /**
   * Get a single row
   */
  get(sql, params, callback) {
    const pgSql = convertPlaceholders(sql);
    getPool().query(pgSql, params)
      .then(result => {
        callback(null, result.rows[0] || null);
      })
      .catch(err => {
        callback(err, null);
      });
  }

  /**
   * Get all rows
   */
  all(sql, params, callback) {
    const pgSql = convertPlaceholders(sql);
    getPool().query(pgSql, params)
      .then(result => {
        callback(null, result.rows);
      })
      .catch(err => {
        callback(err, null);
      });
  }
}

/**
 * Convert SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
 */
function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * Initialize the database: connect and create tables/indexes.
 */
async function initDatabase() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required (PostgreSQL connection string)');
  }

  const { Pool } = require('pg');

  pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    const client = await pool.connect();
    logger.info({ url: DATABASE_URL.replace(/:[^:@]*@/, ':***@') }, 'Connected to PostgreSQL');

    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMP NOT NULL,
        level TEXT NOT NULL,
        service TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        correlation_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_correlation_id ON logs(correlation_id)');

    client.release();
    logger.info('PostgreSQL tables initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to PostgreSQL');
    throw err;
  }
}

/**
 * Get the database adapter instance
 */
function getDatabase() {
  return new DatabaseAdapter();
}

/**
 * Get the shared PostgreSQL connection pool
 * Only available after initDatabase() has run
 */
function getPool() {
  if (!pool) {
    throw new Error('PostgreSQL pool is not initialized. Call initDatabase() first');
  }
  return pool;
}

/**
 * Close database connections
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL connection pool closed');
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  getPool,
  closeDatabase
};
