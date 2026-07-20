const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
require('dotenv').config();

const logger = require('./logger');
const metrics = require('./metrics');
const { initDatabase, getPool } = require('./database');
const { attachSession } = require('./middleware/session');
const { attachApiKey } = require('./middleware/apikey');
const authRoutes = require('./routes/auth');
const passkeyRoutes = require('./routes/passkeys');
const userRoutes = require('./routes/users');
const apiKeyRoutes = require('./routes/apikeys');
const eventRoutes = require('./routes/events');
const verifyRoutes = require('./routes/verify');
const evidenceRoutes = require('./routes/evidence');
const exportRoutes = require('./routes/export');
const scheduleRoutes = require('./routes/schedules');
const tenantRoutes = require('./routes/tenants');
const webhookDeliveryRoutes = require('./routes/webhookDeliveries');
const { startScheduler } = require('./services/scheduler');
const { startDeliveryWorker } = require('./services/webhookDeliveries');

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

    // Unlisted origins get no CORS headers (the browser enforces), rather
    // than an error: same-origin module scripts send an Origin header too,
    // and must not be turned into 500s.
    callback(null, allowedOrigins.indexOf(origin) !== -1 || allowAllOrigins);
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

// Higher ceiling for machine event ingestion. Keyed per API key when one is
// presented (machine fleets often share an egress IP; a leaked key must not
// be able to flood the chain from many IPs either), per IP otherwise.
const { ipKeyGenerator } = require('express-rate-limit');
const eventLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_EVENTS_MAX || '1000'),
  message: 'Too many event requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : ipKeyGenerator(req.ip)),
});

const healthCheckLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_HEALTH_MAX || '60'),
  message: 'Too many health check requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Request duration histogram — only mounted when metrics are enabled so the
// default path pays no per-request overhead.
if (metrics.isEnabled()) {
  app.use(metrics.httpMetricsMiddleware);
}

app.use(limiter);

// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The Vite-built SPA loads scripts as modules from /assets — no inline
      // scripts anywhere, so keep scriptSrc strict.
      scriptSrc: ["'self'"],
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
    // Compare the path without any query string so probes/scrapes with
    // parameters do not slip past the ignore list.
    ignore: (req) => {
      const path = req.url.split('?')[0];
      return path === '/health' || path === '/metrics';
    }
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

// Prometheus metrics — opt-in (METRICS_ENABLED=true) because the output
// exposes operational details (tenant ids, ingestion rates). Optionally
// protected with a bearer token via METRICS_TOKEN; see docs on monitoring.
if (metrics.isEnabled()) {
  logger.info('Prometheus metrics enabled at /metrics');
  app.get('/metrics', metrics.metricsHandler);
}

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/auth/passkeys', passkeyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/events', eventLimiter, eventRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/webhook-deliveries', webhookDeliveryRoutes);

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
  // Retry sweeper for outgoing webhooks; no-op when no webhook is configured.
  startDeliveryWorker();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'clomp backend started');
  });
}).catch(err => {
  logger.fatal({ err }, 'Failed to initialize database');
  process.exit(1);
});
