const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
require('dotenv').config();

const logger = require('./logger');
const { initDatabase, getPool } = require('./database');
const { attachSession } = require('./middleware/session');
const { attachApiKey } = require('./middleware/apikey');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const apiKeyRoutes = require('./routes/apikeys');
const eventRoutes = require('./routes/events');
const verifyRoutes = require('./routes/verify');
const evidenceRoutes = require('./routes/evidence');
const exportRoutes = require('./routes/export');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - restrict to allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:5173', 'http://localhost:3000']; // Default to common dev origins

const allowAllOrigins = allowedOrigins.includes('*');

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like curl or same-origin requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || allowAllOrigins) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  // When '*' is allowed, do not allow credentials to avoid exposing authenticated requests to any origin
  credentials: !allowAllOrigins
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '300'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Higher ceiling for machine event ingestion
const eventLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_EVENTS_MAX || '1000'),
  message: 'Too many event requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const healthCheckLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_HEALTH_MAX || '60'),
  message: 'Too many health check requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// HTTP request logging (skip health checks to reduce noise)
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health'
  }
}));

// Body parsing with size limits to prevent DoS
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Resolve credentials (either or both may be absent; routes decide access)
app.use(attachSession);
app.use(attachApiKey);

// Serve static files for web UI (if built)
const webUiPath = path.join(__dirname, '../../web-ui/dist');
if (require('fs').existsSync(webUiPath)) {
  app.use(express.static(webUiPath));
}

// Health check with database validation
app.get('/health', healthCheckLimiter, async (req, res) => {
  try {
    await getPool().query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/events', eventLimiter, eventRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/export', exportRoutes);

// Serve web UI for all other routes (if built)
// Express 5 (path-to-regexp v8) no longer accepts a bare '*' path,
// so use the named wildcard syntax for the SPA catch-all.
const webUiIndexPath = path.join(__dirname, '../../web-ui/dist/index.html');
if (require('fs').existsSync(webUiIndexPath)) {
  app.get('/{*splat}', (req, res) => {
    res.sendFile(webUiIndexPath);
  });
}

// Initialize database and start server
initDatabase().then(() => {
  startScheduler();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'clomp backend started');
  });
}).catch(err => {
  logger.fatal({ err }, 'Failed to initialize database');
  process.exit(1);
});
