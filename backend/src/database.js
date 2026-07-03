const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Determine database type from environment
const DATABASE_URL = process.env.DATABASE_URL;
const DB_TYPE = DATABASE_URL ? 'postgres' : 'sqlite';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/logs.db');

let db = null;
let pool = null;

/**
 * Database abstraction layer that supports both SQLite and PostgreSQL
 * Provides a unified callback-style API similar to sqlite3
 */
class DatabaseAdapter {
  constructor(type) {
    this.type = type;
  }

  /**
   * Run a query that doesn't return rows (INSERT, UPDATE, DELETE)
   */
  run(sql, params, callback) {
    if (this.type === 'postgres') {
      const pgSql = this._convertPlaceholders(sql);
      pool.query(pgSql, params)
        .then(result => {
          if (callback) callback.call({ changes: result.rowCount }, null);
        })
        .catch(err => {
          if (callback) callback(err);
        });
    } else {
      db.run(sql, params, function(err) {
        if (callback) callback.call(this, err);
      });
    }
  }

  /**
   * Get a single row
   */
  get(sql, params, callback) {
    if (this.type === 'postgres') {
      const pgSql = this._convertPlaceholders(sql);
      pool.query(pgSql, params)
        .then(result => {
          callback(null, result.rows[0] || null);
        })
        .catch(err => {
          callback(err, null);
        });
    } else {
      db.get(sql, params, callback);
    }
  }

  /**
   * Get all rows
   */
  all(sql, params, callback) {
    if (this.type === 'postgres') {
      const pgSql = this._convertPlaceholders(sql);
      pool.query(pgSql, params)
        .then(result => {
          callback(null, result.rows);
        })
        .catch(err => {
          callback(err, null);
        });
    } else {
      db.all(sql, params, callback);
    }
  }

  /**
   * Serialize operations (transactions in PostgreSQL, serialize in SQLite)
   */
  serialize(fn) {
    if (this.type === 'postgres') {
      // PostgreSQL handles this differently - we run operations sequentially
      fn();
    } else {
      db.serialize(fn);
    }
  }

  /**
   * Prepare a statement for batch operations
   */
  prepare(sql) {
    if (this.type === 'postgres') {
      return new PostgresPreparedStatement(sql, pool);
    } else {
      return new SqlitePreparedStatement(db.prepare(sql));
    }
  }

  /**
   * Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
   */
  _convertPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  /**
   * Get the database type
   */
  getType() {
    return this.type;
  }

  /**
   * Begin a transaction
   */
  async beginTransaction() {
    if (this.type === 'postgres') {
      const client = await pool.connect();
      await client.query('BEGIN');
      return client;
    } else {
      return new Promise((resolve, reject) => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) reject(err);
          else resolve(db);
        });
      });
    }
  }

  /**
   * Commit a transaction
   */
  async commitTransaction(client) {
    if (this.type === 'postgres') {
      await client.query('COMMIT');
      client.release();
    } else {
      return new Promise((resolve, reject) => {
        db.run('COMMIT', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Rollback a transaction
   */
  async rollbackTransaction(client) {
    if (this.type === 'postgres') {
      await client.query('ROLLBACK');
      client.release();
    } else {
      return new Promise((resolve, reject) => {
        db.run('ROLLBACK', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

/**
 * PostgreSQL prepared statement wrapper
 */
class PostgresPreparedStatement {
  constructor(sql, pool) {
    this.sql = sql;
    this.pool = pool;
    this.pgSql = this._convertPlaceholders(sql);
    this.pendingOperations = [];
  }

  _convertPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  run(params, callback) {
    this.pool.query(this.pgSql, params)
      .then(result => {
        if (callback) callback.call({ changes: result.rowCount }, null);
      })
      .catch(err => {
        if (callback) callback(err);
      });
  }

  finalize(callback) {
    // PostgreSQL doesn't need to finalize prepared statements in this context
    if (callback) callback(null);
  }
}

/**
 * SQLite prepared statement wrapper
 */
class SqlitePreparedStatement {
  constructor(stmt) {
    this.stmt = stmt;
  }

  run(params, callback) {
    this.stmt.run(params, function(err) {
      if (callback) callback.call(this, err);
    });
  }

  finalize(callback) {
    this.stmt.finalize(callback);
  }
}

/**
 * Initialize the database
 */
async function initDatabase() {
  if (DB_TYPE === 'postgres') {
    return initPostgres();
  } else {
    return initSqlite();
  }
}

/**
 * Initialize PostgreSQL
 */
async function initPostgres() {
  const { Pool } = require('pg');
  
  pool = new Pool({
    connectionString: DATABASE_URL,
  });

  // Test connection
  try {
    const client = await pool.connect();
    logger.info({ type: 'postgres', url: DATABASE_URL.replace(/:[^:@]*@/, ':***@') }, 'Connected to PostgreSQL');
    
    // Create tables
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

    // Create indexes
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
 * Initialize SQLite
 */
function initSqlite() {
  const sqlite3 = require('sqlite3').verbose();
  
  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }
      
      logger.info({ type: 'sqlite', path: DB_PATH }, 'Connected to SQLite');
      
      // Create tables
      db.serialize(() => {
        // Services table
        db.run(`CREATE TABLE IF NOT EXISTS services (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          api_key TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
          if (err) {
            reject(err);
            return;
          }
        });

        // Logs table
        db.run(`CREATE TABLE IF NOT EXISTS logs (
          id TEXT PRIMARY KEY,
          timestamp DATETIME NOT NULL,
          level TEXT NOT NULL,
          service TEXT NOT NULL,
          message TEXT NOT NULL,
          context TEXT,
          correlation_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
          if (err) {
            reject(err);
            return;
          }
        });

        // Create indexes
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_correlation_id ON logs(correlation_id)`);

        logger.info('SQLite tables initialized');
        resolve();
      });
    });
  });
}

/**
 * Get the database adapter instance
 */
function getDatabase() {
  return new DatabaseAdapter(DB_TYPE);
}

/**
 * Get the database type
 */
function getDatabaseType() {
  return DB_TYPE;
}

/**
 * Get the shared PostgreSQL connection pool
 * Only available after initDatabase() has run with DATABASE_URL set
 */
function getPool() {
  if (DB_TYPE !== 'postgres') {
    throw new Error('PostgreSQL pool is not available when using SQLite');
  }
  if (!pool) {
    throw new Error('PostgreSQL pool is not initialized. Call initDatabase() first');
  }
  return pool;
}

/**
 * Close database connections
 */
async function closeDatabase() {
  if (DB_TYPE === 'postgres' && pool) {
    await pool.end();
    logger.info('PostgreSQL connection pool closed');
  } else if (db) {
    return new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) reject(err);
        else {
          logger.info('SQLite database closed');
          resolve();
        }
      });
    });
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  getDatabaseType,
  getPool,
  closeDatabase
};
