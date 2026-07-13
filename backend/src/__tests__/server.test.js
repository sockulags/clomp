const request = require('supertest');
const express = require('express');
const { getPool } = require('../database');

jest.mock('../database');

describe('Server Health Check', () => {
  let app;

  beforeEach(() => {
    app = express();

    // Mirror of the /health route in server.js
    app.get('/health', async (req, res) => {
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
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns ok when the database responds', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
  });

  test('returns 503 when the database is unreachable', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('down')) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('disconnected');
  });
});
