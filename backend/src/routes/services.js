const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDatabase } = require('../database');
const logger = require('../logger');

const router = express.Router();

// POST /api/services - Create a new service (for admin/testing)
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Service name is required' });
    }
    
    const serviceId = uuidv4();
    const apiKey = `sk_${crypto.randomBytes(32).toString('hex')}`;
    
    const db = getDatabase();
    
    db.run(
      `INSERT INTO services (id, name, api_key) VALUES (?, ?, ?)`,
      [serviceId, name, apiKey],
      function(err) {
        if (err) {
          // Handle unique constraint violations
          if (err.message.includes('duplicate key') || err.code === '23505') {
            return res.status(409).json({ error: 'Service name already exists' });
          }
          logger.error({ err }, 'Database error creating service');
          return res.status(500).json({ error: 'Failed to create service' });
        }
        
        res.status(201).json({
          id: serviceId,
          name,
          api_key: apiKey
        });
      }
    );
  } catch (error) {
    logger.error({ err: error }, 'Error creating service');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/services - List all services (for admin/testing)
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    
    db.all(
      `SELECT id, name, created_at FROM services ORDER BY created_at DESC`,
      [],
      (err, rows) => {
        if (err) {
          logger.error({ err }, 'Database error querying services');
          return res.status(500).json({ error: 'Failed to query services' });
        }
        
        res.json({ services: rows });
      }
    );
  } catch (error) {
    logger.error({ err: error }, 'Error querying services');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
