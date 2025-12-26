# P3-06: Lägg till strukturerad loggning

**Prioritet:** 🟡 Medium  
**Kategori:** Kvalitet  
**Tidsuppskattning:** 1-2 timmar

## Problem

Backend använder `console.log` och `console.error` för loggning, vilket:
- Saknar strukturerad output (JSON)
- Saknar log levels
- Saknar timestamps
- Försvårar loggaggregering och analys

## Nuvarande kod

```javascript
// Olika ställen i koden
console.log(`Logging platform backend running on port ${PORT}`);
console.error('Failed to initialize database:', err);
console.log(`Archiving logs older than ${cutoffDateStr}...`);
```

## Åtgärd

### 1. Installera Pino (snabb JSON logger)

```bash
cd backend
npm install pino pino-pretty
```

### 2. Skapa logger-modul

Skapa `backend/src/logger.js`:

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' 
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: {
    service: 'loggplattform-backend',
    version: process.env.npm_package_version || '1.0.0'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
```

### 3. Uppdatera server.js

```javascript
const logger = require('./logger');

// Istället för console.log
logger.info({ port: PORT }, 'Server started');

// Istället för console.error
logger.error({ err }, 'Failed to initialize database');

// Med context
logger.info({ service, count: logsToArchive.length }, 'Archiving logs');
```

### 4. Uppdatera alla filer som loggar

- `server.js`
- `database.js`
- `services/archive.js`
- `services/scheduler.js`
- `routes/logs.js`
- `routes/admin.js`
- `middleware/auth.js`
- `middleware/adminAuth.js`

### 5. Lägg till request logging

```javascript
// server.js
const pinoHttp = require('pino-http');

app.use(pinoHttp({ 
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health'
  }
}));
```

### 6. Uppdatera .env.example

```env
# Logging
LOG_LEVEL=info  # debug, info, warn, error
```

## Acceptanskriterier

- [ ] Pino installerat och konfigurerat
- [ ] Alla console.log/error ersatta
- [ ] JSON-format i produktion
- [ ] Pretty-print i utveckling
- [ ] Request logging aktiverat
- [ ] Tester uppdaterade

## Filer att skapa/ändra

- `backend/src/logger.js` (ny)
- `backend/src/server.js`
- `backend/src/database.js`
- `backend/src/services/archive.js`
- `backend/src/services/scheduler.js`
- `backend/src/routes/*.js`
- `backend/src/middleware/*.js`
- `backend/package.json`
- `.env.example`
