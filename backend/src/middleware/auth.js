const { getDatabase } = require('../database');

async function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  const db = getDatabase();
  
  return new Promise((resolve) => {
    db.get('SELECT id, name FROM services WHERE api_key = ?', [apiKey], (err, service) => {
      if (err) {
        resolve(res.status(500).json({ error: 'Database error' }));
        return;
      }
      
      if (!service) {
        resolve(res.status(401).json({ error: 'Invalid API key' }));
        return;
      }
      
      // Attach service info to request
      req.service = service;
      next();
      resolve();
    });
  });
}

module.exports = { authenticate };
