const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { initDatabase } = require('./database');
const { authenticate } = require('./middleware/auth');
const { authenticateAdmin } = require('./middleware/adminAuth');
const logRoutes = require('./routes/logs');
const serviceRoutes = require('./routes/services');
const adminRoutes = require('./routes/admin');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!process.env.ADMIN_API_KEY) {
  console.error('ERROR: ADMIN_API_KEY environment variable is required');
  console.error('Please set ADMIN_API_KEY in your .env file or environment');
  process.exit(1);
}

// CORS configuration - restrict to allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:5173', 'http://localhost:3000']; // Default to common dev origins

const allowAllOrigins = allowedOrigins.includes('*');

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
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
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1 minute default
  max: parseInt(process.env.RATE_LIMIT_MAX || '100'), // 100 requests per window default
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for log creation
const logLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_LOG_MAX || '1000'), // Higher limit for logs
  message: 'Too many log requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for health check to prevent DoS
// Note: Default limit (60/min) may need adjustment in production environments with
// multiple monitoring systems or load balancers performing frequent health checks.
// Increase RATE_LIMIT_HEALTH_MAX if needed.
const healthCheckLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_HEALTH_MAX || '60'), // 60 requests per minute for health checks
  message: 'Too many health check requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiting to all routes
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

// Middleware with body size limits to prevent DoS
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve static files for web UI (if built)
const webUiPath = path.join(__dirname, '../../web-ui/dist');
if (require('fs').existsSync(webUiPath)) {
  app.use(express.static(webUiPath));
}

// Health check with database validation and rate limiting
app.get('/health', healthCheckLimiter, async (req, res) => {
  try {
    const { getDatabase } = require('./database');
    const db = getDatabase();
    
    // Test database connection
    await new Promise((resolve, reject) => {
      db.get('SELECT 1', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ 
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
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
app.use('/api/services', authenticateAdmin, serviceRoutes);
app.use('/api/logs', authenticate, logLimiter, logRoutes);
app.use('/api/admin', authenticateAdmin, adminRoutes);

// Serve web UI for all other routes (if built)
const webUiIndexPath = path.join(__dirname, '../../web-ui/dist/index.html');
if (require('fs').existsSync(webUiIndexPath)) {
  app.get('*', (req, res) => {
    res.sendFile(webUiIndexPath);
  });
}

// Initialize database and start server
initDatabase().then(() => {
  // Start archive scheduler
  startScheduler();
  
  app.listen(PORT, () => {
    console.log(`Logging platform backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
