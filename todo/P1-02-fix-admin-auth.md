# P1-02: Fixa admin-autentisering

**Prioritet:** 🔴 Kritisk  
**Kategori:** Säkerhet  
**Tidsuppskattning:** 1 timme

## Problem

I `backend/src/middleware/adminAuth.js` tillåts alla giltiga service API-nycklar att utföra admin-operationer om `ADMIN_API_KEY` inte är satt. Detta bryter service-isolering och möjliggör log-manipulation.

Dessutom används inte timing-safe jämförelse vid API-nyckelverifiering, vilket öppnar för timing attacks.

## Nuvarande kod (problematisk)

```javascript
// adminAuth.js - OSÄKER FALLBACK
if (apiKey === adminApiKey) {
  req.isAdmin = true;
  return next();
}

// Fallback - tillåter ALLA service API keys som admin!
const db = getDatabase();
db.get('SELECT id, name FROM services WHERE api_key = ?', [apiKey], ...);
```

## Åtgärd

1. **Ta bort** fallback till service API-nycklar
2. **Kräv** att `ADMIN_API_KEY` alltid är satt
3. **Använd** `crypto.timingSafeEqual()` för jämförelse
4. **Uppdatera** server.js för att kräva ADMIN_API_KEY vid uppstart

## Ny kod

```javascript
const crypto = require('crypto');

async function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const adminApiKey = process.env.ADMIN_API_KEY;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  if (!adminApiKey) {
    console.error('ADMIN_API_KEY not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  
  // Timing-safe comparison
  try {
    const apiKeyBuffer = Buffer.from(apiKey, 'utf8');
    const adminKeyBuffer = Buffer.from(adminApiKey, 'utf8');
    
    if (apiKeyBuffer.length !== adminKeyBuffer.length || 
        !crypto.timingSafeEqual(apiKeyBuffer, adminKeyBuffer)) {
      return res.status(401).json({ error: 'Invalid admin API key' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid admin API key' });
  }
  
  req.isAdmin = true;
  return next();
}
```

## Acceptanskriterier

- [ ] Endast ADMIN_API_KEY accepteras för admin-endpoints
- [ ] Timing-safe jämförelse används
- [ ] Server vägrar starta utan ADMIN_API_KEY
- [ ] Tester uppdaterade och passerar

## Filer att ändra

- `backend/src/middleware/adminAuth.js`
- `backend/src/__tests__/middleware/` (uppdatera/skapa tester)
