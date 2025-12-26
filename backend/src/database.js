const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/logs.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Create tables
      db.serialize(() => {
        // Services table (for API key management)
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

        // Logs table (append-only)
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

        // Create indexes for efficient querying
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_correlation_id ON logs(correlation_id)`);

        // Database initialized - resolve after indexes are created
        resolve();
      });
    });
  });
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

module.exports = {
  initDatabase,
  getDatabase
};
