const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  transport: !isProduction && !isTest
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: {
    service: 'clomp-backend',
    // Read from package.json directly: npm_package_version is only set when
    // launched via npm scripts, not under node/docker/pm2.
    version: require('../package.json').version
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
