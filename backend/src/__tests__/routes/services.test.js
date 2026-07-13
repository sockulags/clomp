const request = require('supertest');
const express = require('express');
const serviceRoutes = require('../../routes/services');
const { getDatabase } = require('../../database');

jest.mock('../../database');
jest.mock('../../logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

describe('Service Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/services', serviceRoutes);
    jest.clearAllMocks();
  });

  describe('POST /api/services', () => {
    test('should create a new service', (done) => {
      const mockDb = {
        run: jest.fn((query, params, callback) => {
          callback(null);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .post('/api/services')
        .send({ name: 'test-service' })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('id');
          expect(res.body).toHaveProperty('api_key');
          expect(res.body.name).toBe('test-service');
          expect(res.body.api_key).toMatch(/^sk_[a-f0-9]{64}$/);
        })
        .end(done);
    });

    test('should reject service without name', (done) => {
      request(app)
        .post('/api/services')
        .send({})
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('Service name is required');
        })
        .end(done);
    });

    test('should return 409 for duplicate service name', (done) => {
      const mockDb = {
        run: jest.fn((query, params, callback) => {
          const error = new Error('duplicate key value violates unique constraint "services_name_key"');
          error.code = '23505';
          callback(error);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .post('/api/services')
        .send({ name: 'duplicate-service' })
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('Service name already exists');
        })
        .end(done);
    });

    test('should return 500 on database error', (done) => {
      const mockDb = {
        run: jest.fn((query, params, callback) => {
          const error = new Error('Database connection failed');
          callback(error);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .post('/api/services')
        .send({ name: 'test-service' })
        .expect(500)
        .expect((res) => {
          expect(res.body.error).toBe('Failed to create service');
        })
        .end(done);
    });
  });

  describe('GET /api/services', () => {
    test('should list all services', (done) => {
      const mockServices = [
        { id: '1', name: 'service-1', created_at: '2024-01-01T00:00:00.000Z' },
        { id: '2', name: 'service-2', created_at: '2024-01-02T00:00:00.000Z' }
      ];
      
      const mockDb = {
        all: jest.fn((query, params, callback) => {
          callback(null, mockServices);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/services')
        .expect(200)
        .expect((res) => {
          expect(res.body.services).toHaveLength(2);
          expect(res.body.services[0].name).toBe('service-1');
        })
        .end(done);
    });

    test('should return empty array when no services exist', (done) => {
      const mockDb = {
        all: jest.fn((query, params, callback) => {
          callback(null, []);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/services')
        .expect(200)
        .expect((res) => {
          expect(res.body.services).toHaveLength(0);
        })
        .end(done);
    });

    test('should return 500 on database error', (done) => {
      const mockDb = {
        all: jest.fn((query, params, callback) => {
          const error = new Error('Database error');
          callback(error);
        })
      };
      getDatabase.mockReturnValue(mockDb);

      request(app)
        .get('/api/services')
        .expect(500)
        .expect((res) => {
          expect(res.body.error).toBe('Failed to query services');
        })
        .end(done);
    });
  });
});
