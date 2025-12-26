const LoggplattformSDK = require('../src/index.js');

// Create SDK instance
const logger = new LoggplattformSDK({
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  apiKey: process.env.API_KEY || 'test-api-key-123',
  service: 'test-service',
  environment: 'test'
});

console.log('Testing Loggplattform Node.js SDK...\n');

// Set correlation ID (uuid is a devDependency for tests)
const { v4: uuidv4 } = require('uuid');
const correlationId = uuidv4();
logger.setCorrelationId(correlationId);
console.log(`Correlation ID: ${correlationId}\n`);

// Send different log levels
logger.info('Test info message', { test: true, step: 1 });
console.log('✓ Sent info log');

logger.warn('Test warning message', { test: true, step: 2 });
console.log('✓ Sent warn log');

logger.error('Test error message', { test: true, step: 3, errorCode: 'TEST_ERROR' });
console.log('✓ Sent error log');

logger.debug('Test debug message', { test: true, step: 4, details: 'Debug information' });
console.log('✓ Sent debug log');

// Wait a bit for async sending
setTimeout(() => {
  console.log('\n✅ All logs sent! Check the web UI at http://localhost:8080');
  logger.destroy();
  process.exit(0);
}, 2000);
