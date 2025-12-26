#!/usr/bin/env node
/**
 * Development Setup Script
 * 
 * Creates a test service with API key for local development.
 * DO NOT use in production!
 * 
 * Usage: node scripts/setup-dev.js
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/logs.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

console.log('🔧 Development Setup Script');
console.log('===========================\n');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Failed to connect to database:', err.message);
    process.exit(1);
  }
  console.log(`📂 Database: ${DB_PATH}`);
});

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_key TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp DATETIME NOT NULL,
    level TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    correlation_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_correlation_id ON logs(correlation_id)`);

  // Insert development test service
  const testServiceId = 'dev-test-service';
  const testServiceName = 'dev-service';
  const testApiKey = 'dev-api-key-' + require('crypto').randomBytes(16).toString('hex');

  db.run(
    `INSERT OR REPLACE INTO services (id, name, api_key) VALUES (?, ?, ?)`,
    [testServiceId, testServiceName, testApiKey],
    function(err) {
      if (err) {
        console.error('❌ Failed to create test service:', err.message);
        db.close();
        process.exit(1);
      }

      console.log('\n✅ Development service created:\n');
      console.log('   Service Name: ' + testServiceName);
      console.log('   API Key:      ' + testApiKey);
      console.log('\n📝 Add to your .env file:');
      console.log(`   LOGGPLATTFORM_API_KEY=${testApiKey}`);
      console.log('\n⚠️  WARNING: This is for development only. Never use in production!\n');

      db.close((err) => {
        if (err) {
          console.error('Error closing database:', err.message);
        }
        process.exit(0);
      });
    }
  );
});
