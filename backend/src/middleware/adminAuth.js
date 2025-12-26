const crypto = require('crypto');

/**
 * Admin authentication middleware
 * 
 * Requires ADMIN_API_KEY environment variable to be set.
 * Uses timing-safe comparison to prevent timing attacks.
 */
async function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const adminApiKey = process.env.ADMIN_API_KEY;
  
  // Check if API key is provided
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  // Check if admin key is configured
  if (!adminApiKey) {
    console.error('ADMIN_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    const apiKeyBuffer = Buffer.from(apiKey, 'utf8');
    const adminKeyBuffer = Buffer.from(adminApiKey, 'utf8');
    
    // Check length first (this is not timing-safe, but necessary)
    // The actual key comparison below is timing-safe
    if (apiKeyBuffer.length !== adminKeyBuffer.length) {
      return res.status(401).json({ error: 'Invalid admin API key' });
    }
    
    // Timing-safe comparison
    if (!crypto.timingSafeEqual(apiKeyBuffer, adminKeyBuffer)) {
      return res.status(401).json({ error: 'Invalid admin API key' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid admin API key' });
  }
  
  req.isAdmin = true;
  return next();
}

module.exports = { authenticateAdmin };
