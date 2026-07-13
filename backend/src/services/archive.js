const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');
const { getDatabase, getPool } = require('../database');
const logger = require('../logger');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '../../data/archives');
const ARCHIVE_RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '30');
const ARCHIVE_BATCH_SIZE = parseInt(process.env.ARCHIVE_BATCH_SIZE || '10000');

// Ensure archive directory exists
async function ensureArchiveDir() {
  if (!fsSync.existsSync(ARCHIVE_DIR)) {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * Get archive file path for a specific date and service
 */
function getArchiveFilePath(date, service) {
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const serviceDir = path.join(ARCHIVE_DIR, dateStr);
  return path.join(serviceDir, `${service}.jsonl`);
}

/**
 * Delete logs by IDs (after they have been written to an archive file)
 */
async function deleteLogs(logIds) {
  // Use the shared connection pool from the database module
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Delete in batches to avoid query too long
    const batchSize = 100;
    for (let i = 0; i < logIds.length; i += batchSize) {
      const batch = logIds.slice(i, i + batchSize);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(',');
      await client.query(`DELETE FROM logs WHERE id IN (${placeholders})`, batch);
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Archive logs older than specified days
 * Moves logs from database to JSONL files (one file per service per day)
 */
async function archiveOldLogs(daysOld = 1) {
  try {
    await ensureArchiveDir();
    
    const db = getDatabase();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    cutoffDate.setHours(0, 0, 0, 0); // Start of day
    
    const cutoffDateStr = cutoffDate.toISOString();
    
    logger.info({ cutoffDate: cutoffDateStr }, 'Archiving old logs');
    
    // Get all services
    const services = await new Promise((resolve, reject) => {
      db.all('SELECT DISTINCT name FROM services', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.name));
      });
    });
    
    let totalArchived = 0;
    
    for (const service of services) {
      // Get logs to archive for this service
      const logsToArchive = await new Promise((resolve, reject) => {
        db.all(
          `SELECT id, timestamp, level, service, message, context, correlation_id, created_at
           FROM logs
           WHERE service = ? AND timestamp < ?
           ORDER BY timestamp ASC
           LIMIT ?`,
          [service, cutoffDateStr, ARCHIVE_BATCH_SIZE],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });
      
      if (logsToArchive.length === 0) {
        continue;
      }
      
      // Group logs by date
      const logsByDate = {};
      for (const log of logsToArchive) {
        const logDate = new Date(log.timestamp);
        const dateStr = logDate.toISOString().split('T')[0];
        
        if (!logsByDate[dateStr]) {
          logsByDate[dateStr] = [];
        }
        
        let parsedContext = null;
        if (log.context) {
          try {
            parsedContext = JSON.parse(log.context);
          } catch {
            parsedContext = null;
          }
        }
        
        logsByDate[dateStr].push({
          id: log.id,
          timestamp: log.timestamp,
          level: log.level,
          service: log.service,
          message: log.message,
          context: parsedContext,
          correlation_id: log.correlation_id,
          created_at: log.created_at
        });
      }
      
      // Write to archive files (one file per day per service)
      for (const [dateStr, logs] of Object.entries(logsByDate)) {
        const archivePath = getArchiveFilePath(new Date(dateStr), service);
        const archiveDir = path.dirname(archivePath);
        
        // Ensure directory exists
        if (!fsSync.existsSync(archiveDir)) {
          await fs.mkdir(archiveDir, { recursive: true });
        }
        
        // Append logs to file (JSONL format - one JSON object per line)
        const lines = logs.map(log => JSON.stringify(log)).join('\n') + '\n';
        await fs.appendFile(archivePath, lines, 'utf8');
        
        // Delete archived logs from database
        const logIds = logs.map(log => log.id);
        await deleteLogs(logIds);

        totalArchived += logs.length;
        logger.debug({ service, dateStr, count: logs.length }, 'Archived logs for service');
      }
    }
    
    logger.info({ totalArchived }, 'Archive complete');
    return totalArchived;
  } catch (error) {
    logger.error({ err: error }, 'Archive error');
    throw error;
  }
}

/**
 * Read archived logs from files for a specific date range and service
 * 
 * @param {string} service - Service name
 * @param {string} startTime - Start time ISO string
 * @param {string} endTime - End time ISO string  
 * @param {object} filters - Filters (level, correlationId)
 * @param {number} maxLogs - Maximum number of logs to return (for performance)
 */
async function readArchivedLogs(service, startTime, endTime, filters = {}, maxLogs = null) {
  try {
    await ensureArchiveDir();
    
    const startDate = startTime ? new Date(startTime) : new Date(0);
    const endDate = endTime ? new Date(endTime) : new Date();
    
    // Get all dates in range
    const dates = [];
    const currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    
    while (currentDate <= endDate) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    const logs = [];
    
    for (const date of dates) {
      const archivePath = getArchiveFilePath(date, service);
      
      if (!fsSync.existsSync(archivePath)) {
        continue;
      }
      
      // Check file size before reading to prevent memory issues
      const stats = await fs.stat(archivePath);
      const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit
      
      if (stats.size > MAX_FILE_SIZE) {
        logger.warn({ archivePath, size: stats.size }, 'Archive file too large, skipping');
        continue;
      }
      
      // Read file using streaming (line by line) to avoid loading entire file into memory
      await new Promise((resolve, reject) => {
        const fileStream = fsSync.createReadStream(archivePath, { encoding: 'utf8' });
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });
        
        rl.on('line', (line) => {
          // Skip empty lines
          if (!line.trim()) {
            return;
          }
          
          // Early exit if we've reached the maximum number of logs
          if (maxLogs && logs.length >= maxLogs) {
            rl.close();
            return;
          }
          
          try {
            const log = JSON.parse(line);
            
            // Apply filters
            const logTime = new Date(log.timestamp);
            
            if (logTime < startDate || logTime > endDate) {
              return;
            }
            
            if (filters.level && log.level !== filters.level) {
              return;
            }
            
            if (filters.correlationId && log.correlation_id !== filters.correlationId) {
              return;
            }
            
            logs.push(log);
            
            // Early exit if we've reached the maximum number of logs
            if (maxLogs && logs.length >= maxLogs) {
              rl.close();
            }
          } catch (parseError) {
            logger.warn({ err: parseError }, 'Failed to parse log line');
          }
        });
        
        rl.on('close', () => {
          // Ensure the underlying file stream is cleaned up when readline closes,
          // including when it is closed early due to reaching maxLogs.
          fileStream.destroy();
          resolve();
        });
        
        rl.on('error', (err) => {
          // Clean up the file stream if an error occurs while reading.
          fileStream.destroy();
          reject(err);
        });
      });
      
      // Break outer loop if we've reached the limit
      if (maxLogs && logs.length >= maxLogs) {
        break;
      }
    }
    
    // Sort by timestamp descending
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return logs;
  } catch (error) {
    logger.error({ err: error }, 'Error reading archived logs');
    return [];
  }
}

/**
 * Clean up old archive files (older than retention period)
 */
async function cleanupOldArchives() {
  try {
    await ensureArchiveDir();
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ARCHIVE_RETENTION_DAYS);
    
    const entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
    let deletedCount = 0;
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirDate = new Date(entry.name);
        if (dirDate < cutoffDate) {
          const dirPath = path.join(ARCHIVE_DIR, entry.name);
          await fs.rm(dirPath, { recursive: true, force: true });
          deletedCount++;
          logger.debug({ directory: entry.name }, 'Deleted old archive directory');
        }
      }
    }
    
    if (deletedCount > 0) {
      logger.info({ deletedCount }, 'Cleanup complete');
    }
    
    return deletedCount;
  } catch (error) {
    logger.error({ err: error }, 'Cleanup error');
    throw error;
  }
}

module.exports = {
  archiveOldLogs,
  readArchivedLogs,
  cleanupOldArchives,
  getArchiveFilePath
};
