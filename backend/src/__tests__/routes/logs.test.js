const request = require('supertest');
const express = require('express');
const logRoutes = require('../../routes/logs');
const { getDatabase, getPool } = require('../../database');
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
    test('should create multiple log entries using the shared pool', (done) => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        release: jest.fn()
      };
      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient)
      };
      getPool.mockReturnValue(mockPool);
      getDatabase.mockReturnValue({});

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
          expect(getPool).toHaveBeenCalled();
          expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
          expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
          expect(mockClient.release).toHaveBeenCalled();
        })
        .end(done);
    });

    test('should rollback and return 500 on insert failure', (done) => {
      const mockClient = {
        query: jest.fn((sql) => {
          if (typeof sql === 'string' && sql.startsWith('INSERT')) {
            return Promise.reject(new Error('insert failed'));
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }),
        release: jest.fn()
      };
      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient)
      };
      getPool.mockReturnValue(mockPool);
      getDatabase.mockReturnValue({});

      request(app)
        .post('/api/logs/batch')
        .send({
          logs: [{ level: 'info', message: 'Log 1' }]
        })
        .expect(500)
        .expect(() => {
          expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
          expect(mockClient.release).toHaveBeenCalled();
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

  describe('GET /api/logs/:id', () => {
    test('should return 200 with the log when the owning service requests a valid id', (done) => {
      const mockRow = {
        id: 'log-123',
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'info',
        service: 'test-service',
        message: 'Test log',
        context: null,
        correlation_id: 'corr-1',
        created_at: '2024-01-01T00:00:00.000Z'
      };

      const mockDb = {
        get: jest.fn((query, params, callback) => {
          callback(null, mockRow);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/logs/log-123')
        .expect(200)
        .expect((res) => {
          expect(mockDb.get).toHaveBeenCalled();
          expect(mockDb.get.mock.calls[0][1]).toEqual(['log-123', 'test-service']);
          expect(res.body).toEqual({
            id: 'log-123',
            timestamp: '2024-01-01T00:00:00.000Z',
            level: 'info',
            service: 'test-service',
            message: 'Test log',
            context: null,
            correlation_id: 'corr-1',
            created_at: '2024-01-01T00:00:00.000Z'
          });
        })
        .end(done);
    });

    test('should return 404 when the id belongs to another service', (done) => {
      // The WHERE id = ? AND service = ? filter excludes another service's row,
      // so the driver yields no row.
      const mockDb = {
        get: jest.fn((query, params, callback) => {
          callback(null, undefined);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/logs/other-service-log')
        .expect(404)
        .expect((res) => {
          expect(res.body).toEqual({ error: 'Log not found' });
        })
        .end(done);
    });

    test('should return 404 when the id does not exist', (done) => {
      const mockDb = {
        get: jest.fn((query, params, callback) => {
          callback(null, undefined);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/logs/nonexistent')
        .expect(404)
        .expect((res) => {
          expect(res.body).toEqual({ error: 'Log not found' });
        })
        .end(done);
    });

    test('should return 500 when the database query fails', (done) => {
      const mockDb = {
        get: jest.fn((query, params, callback) => {
          callback(new Error('db failure'));
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/logs/log-123')
        .expect(500)
        .expect((res) => {
          expect(res.body).toEqual({ error: 'Failed to query log' });
        })
        .end(done);
    });

    test('should parse a non-null context into an object', (done) => {
      const mockRow = {
        id: 'log-456',
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'error',
        service: 'test-service',
        message: 'Context log',
        context: '{"key":"value"}',
        correlation_id: null,
        created_at: '2024-01-01T00:00:00.000Z'
      };

      const mockDb = {
        get: jest.fn((query, params, callback) => {
          callback(null, mockRow);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/logs/log-456')
        .expect(200)
        .expect((res) => {
          expect(res.body.context).toEqual({ key: 'value' });
        })
        .end(done);
    });
  });
});
