# Loggplattform Node.js SDK

SDK för att skicka loggar till Loggplattform från Node.js-applikationer.

## Installation

```bash
npm install @loggplattform/sdk-nodejs
```

## Användning

### Grundläggande användning

```javascript
const LoggplattformSDK = require('@loggplattform/sdk-nodejs');

const logger = new LoggplattformSDK({
  apiUrl: 'http://localhost:3000',
  apiKey: 'your-api-key-here',
  service: 'my-service',
  environment: 'production'
});

// Skicka loggar
logger.info('Application started');
logger.warn('High memory usage detected');
logger.error('Failed to connect to database');
logger.debug('Processing request', { userId: 123 });
```

### Med miljövariabler

```bash
export LOGGPLATTFORM_API_URL=http://localhost:3000
export LOGGPLATTFORM_API_KEY=your-api-key-here
export LOGGPLATTFORM_SERVICE=my-service
```

```javascript
const logger = new LoggplattformSDK();
logger.info('Using environment variables');
```

### Med kontext

```javascript
logger.info('User logged in', {
  userId: 123,
  email: 'user@example.com',
  ip: '192.168.1.1'
});
```

### Med korrelations-ID

```javascript
// Install uuid för att generera korrelations-ID: npm install uuid
const { v4: uuidv4 } = require('uuid');

const correlationId = uuidv4();
logger.setCorrelationId(correlationId);

logger.info('Request started', { path: '/api/users' });
logger.debug('Database query', { query: 'SELECT * FROM users' });
logger.info('Request completed');
```

**Notera:** `uuid` är inte ett SDK-beroende. Installera det endast om du behöver generera korrelations-ID. Du kan också använda vilket annat bibliotek eller metod som helst för att generera ID:n.

## API

### `new LoggplattformSDK(options)`

Skapar en ny SDK-instans.

**Options:**
- `apiUrl` (string): URL till loggplattform API (default: `http://localhost:3000`)
- `apiKey` (string): API-nyckel för autentisering
- `service` (string): Tjänstnamn (default: `default-service`)
- `environment` (string): Miljö (default: `development`)
- `correlationId` (string): Korrelations-ID för alla loggar
- `flushInterval` (number): Intervall för att skicka loggar i millisekunder (default: 5000)
- `batchSize` (number): Antal loggar att skicka per batch (default: 10)

### Metoder

- `logger.info(message, context)` - Skicka info-logg
- `logger.warn(message, context)` - Skicka varning
- `logger.error(message, context)` - Skicka fel
- `logger.debug(message, context)` - Skicka debug-logg
- `logger.setCorrelationId(id)` - Sätt korrelations-ID
- `logger.flush()` - Skicka alla väntande loggar asynkront
- `logger.flushSync()` - Skicka alla väntande loggar synkront
- `logger.destroy()` - Stäng SDK och skicka alla väntande loggar

## Säkerhet

SDK:ns fel kraschar aldrig applikationen. Om loggning misslyckas fortsätter applikationen att fungera normalt.
