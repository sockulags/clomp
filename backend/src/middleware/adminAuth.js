const { getDatabase } = require('../database');

/**
 * Admin authentication middleware
 * Requires either:
 * 1. A valid API key (any service can perform admin operations)
 * 2. Or a specific admin API key set via ADMIN_API_KEY env variable
 */
async function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const adminApiKey = process.env.ADMIN_API_KEY;
  
  // If ADMIN_API_KEY is set, require it for admin operations
  if (adminApiKey) {
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }
    
    if (apiKey === adminApiKey) {
      // Admin API key is valid
      req.isAdmin = true;
      return next();
    }
    
    // If admin key is set but doesn't match, deny access
    return res.status(403).json({ error: 'Admin access denied' });
  }
  
  // If no ADMIN_API_KEY is set, fall back to regular API key authentication
  // This allows any valid service to perform admin operations
  const db = getDatabase();
  
  db.get('SELECT id, name FROM services WHERE api_key = ?', [apiKey], (err, service) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (!service) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Attach service info to request
    req.service = service;
    req.isAdmin = true;
    return next();
  });
}

module.exports = { authenticateAdmin };
