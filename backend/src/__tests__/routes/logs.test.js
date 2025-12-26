const request = require('supertest');
const express = require('express');
const logRoutes = require('../../routes/logs');
const { getDatabase } = require('../../database');
const { readArchivedLogs } = require('../../services/archive');

jest.mock('../../database');
jest.mock('../../services/archive');

const mockAuthenticate = jest.fn((req, res, next) => {
  req.service = { id: 'test-id', name: 'test-service' };
  next();
});

jest.mock('../../middleware/auth', () => ({
  authenticate: mockAuthenticate
}));

describe('Log Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Apply authentication middleware
    app.use(mockAuthenticate);
    app.use('/api/logs', logRoutes);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/logs', () => {
    test('should create a log entry', (done) => {
      const mockDb = {
        run: jest.fn((query, params, callback) => {
          callback(null);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .post('/api/logs')
        .send({
          level: 'info',
          message: 'Test log message',
          context: { key: 'value' },
          correlation_id: 'test-correlation-id'
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('id');
          expect(res.body.level).toBe('info');
          expect(res.body.message).toBe('Test log message');
          expect(res.body.service).toBe('test-service');
        })
        .end(done);
    });

    test('should reject log without level', (done) => {
      request(app)
        .post('/api/logs')
        .send({
          message: 'Test log message'
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('Level and message are required');
        })
        .end(done);
    });

    test('should reject log with invalid level', (done) => {
      request(app)
        .post('/api/logs')
        .send({
          level: 'invalid',
          message: 'Test log message'
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toContain('Invalid level');
        })
        .end(done);
    });
  });

  describe('POST /api/logs/batch', () => {
    test('should create multiple log entries', (done) => {
      const mockStmt = {
        run: jest.fn((_params, callback) => {
          // Simulate successful insert without time-based delay
          callback(null);
        }),
        finalize: jest.fn((callback) => {
          callback(null);
        })
      };
      
      const mockDb = {
        serialize: jest.fn((callback) => {
          callback();
        }),
        run: jest.fn((query, callback) => {
          if (query === 'BEGIN TRANSACTION' || query === 'COMMIT' || query === 'ROLLBACK') {
            // These are called without a callback
            if (callback) callback(null);
          }
        }),
        prepare: jest.fn(() => mockStmt)
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .post('/api/logs/batch')
        .send({
          logs: [
            { level: 'info', message: 'Log 1' },
            { level: 'error', message: 'Log 2' }
          ]
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.created).toBe(2);
          expect(res.body.logs).toHaveLength(2);
        })
        .end(done);
    });

    test('should reject batch without logs array', (done) => {
      request(app)
        .post('/api/logs/batch')
        .send({})
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('logs must be an array');
        })
        .end(done);
    });

    test('should reject empty batch', (done) => {
      request(app)
        .post('/api/logs/batch')
        .send({ logs: [] })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('logs array cannot be empty');
        })
        .end(done);
    });

    test('should return validation errors with created: 0', (done) => {
      request(app)
        .post('/api/logs/batch')
        .send({
          logs: [
            { level: 'info', message: 'Valid log' },
            { level: 'invalid', message: 'Invalid level' }
          ]
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toContain('Validation errors');
          expect(res.body.created).toBe(0);
          expect(res.body.errors).toBeInstanceOf(Array);
          expect(res.body.errors.length).toBeGreaterThan(0);
        })
        .end(done);
    });

    test('should reject batch with invalid timestamp', (done) => {
      request(app)
        .post('/api/logs/batch')
        .send({
          logs: [
            { level: 'info', message: 'Log with invalid timestamp', timestamp: 'not-a-date' }
          ]
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toContain('Validation errors');
          expect(res.body.created).toBe(0);
          expect(res.body.errors[0].error).toContain('Invalid timestamp format');
        })
        .end(done);
    });

    test('should reject batch with timestamp out of bounds', (done) => {
      request(app)
        .post('/api/logs/batch')
        .send({
          logs: [
            { level: 'info', message: 'Log with future timestamp', timestamp: '2099-01-01T00:00:00.000Z' }
          ]
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toContain('Validation errors');
          expect(res.body.created).toBe(0);
          expect(res.body.errors[0].error).toContain('out of reasonable bounds');
        })
        .end(done);
    });
  });

  describe('GET /api/logs', () => {
    test('should return logs from database', (done) => {
      const mockLogs = [
        {
          id: 'log-1',
          timestamp: '2024-01-01T00:00:00.000Z',
          level: 'info',
          service: 'test-service',
          message: 'Test log',
          context: null,
          correlation_id: null,
          created_at: '2024-01-01T00:00:00.000Z'
        }
      ];

      const mockDb = {
        all: jest.fn((query, params, callback) => {
          callback(null, mockLogs);
        })
      };
      getDatabase.mockReturnValue(mockDb);
      readArchivedLogs.mockResolvedValue([]);

      request(app)
        .get('/api/logs')
        .expect(200)
        .expect((res) => {
          expect(res.body.logs).toHaveLength(1);
          expect(res.body.total).toBe(1);
        })
        .end(done);
    });
  });
});
