const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../database');
const { readArchivedLogs } = require('../services/archive');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiter for batch endpoint with lower limit since each request can contain multiple logs
const batchLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  // Lower base limit since each request can contain multiple logs
  max: parseInt(process.env.RATE_LIMIT_BATCH_MAX || '100'), // 100 batch requests per minute
  message: 'Too many batch log requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many batch log requests from this IP, please try again later.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
    });
  }
});

// POST /api/logs/batch - Create multiple log entries at once
router.post('/batch', batchLimiter, async (req, res) => {
  try {
    const { logs } = req.body;
    const service = req.service.name;
    
    if (!Array.isArray(logs)) {
      return res.status(400).json({ error: 'logs must be an array' });
    }
    
    if (logs.length === 0) {
      return res.status(400).json({ error: 'logs array cannot be empty' });
    }
    
    // Limit batch size to prevent abuse
    const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE || '100');
    if (logs.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` });
    }
    
    const validLevels = ['info', 'warn', 'error', 'debug'];
    const db = getDatabase();
    const results = [];
    const errors = [];
    
    // Validate all logs first
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (!log.level || !log.message) {
        errors.push({ index: i, error: 'Level and message are required' });
        continue;
      }
      if (!validLevels.includes(log.level.toLowerCase())) {
        errors.push({ index: i, error: `Invalid level. Must be one of: ${validLevels.join(', ')}` });
        continue;
      }
      // Validate timestamp if provided
      if (log.timestamp) {
        const timestampDate = new Date(log.timestamp);
        if (isNaN(timestampDate.getTime())) {
          errors.push({ index: i, error: 'Invalid timestamp format. Must be a valid ISO 8601 date string' });
          continue;
        }
        // Check if timestamp is within reasonable bounds (1 year in past to 1 hour in future)
        const now = Date.now();
        const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
        const oneHourFromNow = now + (60 * 60 * 1000);
        const timestampMs = timestampDate.getTime();
        if (timestampMs < oneYearAgo || timestampMs > oneHourFromNow) {
          errors.push({ index: i, error: 'Timestamp out of reasonable bounds (must be within 1 year ago to 1 hour in future)' });
          continue;
        }
      }
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation errors: entire batch rejected; no logs were created',
        errors,
        created: 0
      });
    }
    
    // Insert all logs in a transaction
    await new Promise((resolve, reject) => {
      let transactionFailed = false; // Track if transaction has already failed
      
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        const stmt = db.prepare(
          `INSERT INTO logs (id, timestamp, level, service, message, context, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        
        let completed = 0;
        const total = logs.length;
        
        for (const log of logs) {
          const logId = uuidv4();
          // Use provided timestamp if available, otherwise use current time
          const timestamp = log.timestamp || new Date().toISOString();
          const contextJson = log.context ? JSON.stringify(log.context) : null;
          
          stmt.run(
            [logId, timestamp, log.level.toLowerCase(), service, log.message, contextJson, log.correlation_id || null],
            function(err) {
              // Skip processing if transaction already failed
              if (transactionFailed) {
                return;
              }
              
              if (err) {
                transactionFailed = true;
                db.run('ROLLBACK', () => {
                  reject(err);
                });
                return;
              }
              
              results.push({
                id: logId,
                timestamp,
                level: log.level.toLowerCase(),
                service,
                message: log.message,
                context: log.context,
                correlation_id: log.correlation_id || null
              });
              
              completed++;
              if (completed >= total) {
                stmt.finalize((finalizeErr) => {
                  if (finalizeErr) {
                    transactionFailed = true;
                    db.run('ROLLBACK', () => {
                      reject(finalizeErr);
                    });
                  } else {
                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) {
                        transactionFailed = true;
                        reject(commitErr);
                      } else {
                        resolve();
                      }
                    });
                  }
                });
              }
            }
          );
        }
      });
    });
    
    res.status(201).json({
      created: results.length,
      logs: results
    });
  } catch (error) {
    console.error('Error creating batch logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/logs - Create a new log entry
router.post('/', async (req, res) => {
  try {
    const { level, message, context, correlation_id } = req.body;
    const service = req.service.name;
    
    // Validate required fields
    if (!level || !message) {
      return res.status(400).json({ error: 'Level and message are required' });
    }
    
    // Validate level
    const validLevels = ['info', 'warn', 'error', 'debug'];
    if (!validLevels.includes(level.toLowerCase())) {
      return res.status(400).json({ error: `Invalid level. Must be one of: ${validLevels.join(', ')}` });
    }
    
    const logId = uuidv4();
    const timestamp = new Date().toISOString();
    const contextJson = context ? JSON.stringify(context) : null;
    
    const db = getDatabase();
    
    db.run(
      `INSERT INTO logs (id, timestamp, level, service, message, context, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [logId, timestamp, level.toLowerCase(), service, message, contextJson, correlation_id || null],
      function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to save log' });
        }
        
        res.status(201).json({
          id: logId,
          timestamp,
          level: level.toLowerCase(),
          service,
          message,
          context,
          correlation_id: correlation_id || null
        });
      }
    );
  } catch (error) {
    console.error('Error creating log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/logs - Query logs with filtering (from DB + archived files)
router.get('/', async (req, res) => {
  try {
    const { 
      level, 
      start_time, 
      end_time, 
      correlation_id,
      limit = 100,
      offset = 0 
    } = req.query;
    
    const serviceName = req.service.name;
    const db = getDatabase();
    const conditions = [];
    const params = [];
    
    // Service isolation - only show logs for the authenticated service
    conditions.push('service = ?');
    params.push(serviceName);
    
    if (level) {
      conditions.push('level = ?');
      params.push(level.toLowerCase());
    }
    
    if (start_time) {
      conditions.push('timestamp >= ?');
      params.push(start_time);
    }
    
    if (end_time) {
      conditions.push('timestamp <= ?');
      params.push(end_time);
    }
    
    if (correlation_id) {
      conditions.push('correlation_id = ?');
      params.push(correlation_id);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Get logs from database
    const dbLogsPromise = new Promise((resolve, reject) => {
      db.all(
        `SELECT id, timestamp, level, service, message, context, correlation_id, created_at
         FROM logs ${whereClause}
         ORDER BY timestamp DESC`,
        params,
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          
          const logs = rows.map(row => {
            let parsedContext = null;

            if (row.context) {
              try {
                parsedContext = JSON.parse(row.context);
              } catch (parseError) {
                console.error('Failed to parse log context JSON for log id:', row.id, parseError);
                parsedContext = null;
              }
            }

            return {
              id: row.id,
              timestamp: row.timestamp,
              level: row.level,
              service: row.service,
              message: row.message,
              context: parsedContext,
              correlation_id: row.correlation_id,
              created_at: row.created_at
            };
          });
          
          resolve(logs);
        }
      );
    });
    
    // Get logs from archived files (if time range overlaps with archives)
    const filters = {
      level: level ? level.toLowerCase() : null,
      correlationId: correlation_id || null
    };
    
    // To prevent memory issues, limit archive reading to a reasonable multiple of the requested range
    // (offset + limit). This helps when there are millions of archived logs.
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);
    const maxArchiveLogs = Math.max((limitNum + offsetNum) * 2, 1000); // Read at most 2x requested range or 1000
    
    const archivedLogsPromise = readArchivedLogs(serviceName, start_time, end_time, filters, maxArchiveLogs);
    
    // Wait for both queries
    const [dbLogs, archivedLogs] = await Promise.all([dbLogsPromise, archivedLogsPromise]);
    
    // Combine and deduplicate logs (by ID)
    const logMap = new Map();
    
    // Add archived logs first (older)
    for (const log of archivedLogs) {
      logMap.set(log.id, log);
    }
    
    // Add database logs (newer, will overwrite if duplicate)
    for (const log of dbLogs) {
      logMap.set(log.id, log);
    }
    
    // Convert to array and sort by timestamp descending
    const allLogs = Array.from(logMap.values());
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Apply pagination
    const total = allLogs.length;
    const paginatedLogs = allLogs.slice(offsetNum, offsetNum + limitNum);
    
    res.json({
      logs: paginatedLogs,
      total: total,
      limit: limitNum,
      offset: offsetNum,
      sources: {
        database: dbLogs.length,
        archived: archivedLogs.length
      }
    });
  } catch (error) {
    console.error('Error querying logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/logs/:id - Get a specific log entry
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    db.get(
      `SELECT id, timestamp, level, service, message, context, correlation_id, created_at
       FROM logs WHERE id = ? AND service = ?`,
      [id, req.service.name],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to query log' });
        }
        
        if (!row) {
          return res.status(404).json({ error: 'Log not found' });
        }
        
        res.json({
          id: row.id,
          timestamp: row.timestamp,
          level: row.level,
          service: row.service,
          message: row.message,
          context: row.context ? JSON.parse(row.context) : null,
          correlation_id: row.correlation_id,
          created_at: row.created_at
        });
      }
    );
  } catch (error) {
    console.error('Error querying log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
