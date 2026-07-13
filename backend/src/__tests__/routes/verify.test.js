const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockVerifyChain = jest.fn();
const mockPoolQuery = jest.fn();
const mockVerifySignature = jest.fn();

jest.mock('../../services/chain', () => ({
  verifyChain: (...args) => mockVerifyChain(...args)
}));
jest.mock('../../services/checkpoints', () => ({
  verifyCheckpointSignature: (...args) => mockVerifySignature(...args)
}));
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const verifyRoutes = require('../../routes/verify');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function makeApp() {
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 'u1', role: 'auditor', tenant_id: TENANT };
    next();
  });
  app.use('/api/verify', verifyRoutes);
  return app;
}

describe('verify route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  test('reports an intact chain with checkpoint status', async () => {
    mockVerifyChain.mockResolvedValue({ intact: true, verified: 42 });
    mockPoolQuery.mockResolvedValue({
      rows: [{
        tenant_id: TENANT, sequence: '40', hash: 'ab'.repeat(32),
        signature: 'sig', public_key: 'pem', signed_at: new Date('2026-07-13T02:00:00Z')
      }]
    });
    mockVerifySignature.mockReturnValue(true);

    const res = await request(makeApp()).get('/api/verify');
    expect(res.status).toBe(200);
    expect(res.body.intact).toBe(true);
    expect(res.body.verified).toBe(42);
    expect(res.body.checkpoint).toEqual({
      sequence: 40,
      signed_at: '2026-07-13T02:00:00.000Z',
      signature_valid: true
    });
    expect(mockVerifyChain).toHaveBeenCalledWith(TENANT, 1, null);
  });

  test('reports a broken chain', async () => {
    mockVerifyChain.mockResolvedValue({ intact: false, verified: 10, firstBreak: 11, reason: 'hash mismatch' });
    const res = await request(makeApp()).get('/api/verify?from=1&to=100');
    expect(res.status).toBe(200);
    expect(res.body.intact).toBe(false);
    expect(res.body.firstBreak).toBe(11);
    expect(res.body.checkpoint).toBeNull();
    expect(mockVerifyChain).toHaveBeenCalledWith(TENANT, 1, 100);
  });

  test('validates the range parameters', async () => {
    expect((await request(makeApp()).get('/api/verify?from=0')).status).toBe(400);
    expect((await request(makeApp()).get('/api/verify?from=5&to=2')).status).toBe(400);
  });

  test('requires authentication', async () => {
    const app = express();
    app.use('/api/verify', verifyRoutes);
    expect((await request(app).get('/api/verify')).status).toBe(401);
  });
});
