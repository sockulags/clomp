const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  getDefaultTenantId: () => 'aaaaaaaa-0000-0000-0000-000000000001'
}));

const apiKeyRoutes = require('../../routes/apikeys');
const { attachApiKey } = require('../../middleware/apikey');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function appAs(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/keys', apiKeyRoutes);
  return app;
}

const admin = { id: 'admin-1', email: 'a@x.se', role: 'admin', tenant_id: TENANT };

describe('api key routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  test('requires admin', async () => {
    expect((await request(appAs({ ...admin, role: 'editor' })).get('/api/keys')).status).toBe(403);
    expect((await request(appAs(null)).get('/api/keys')).status).toBe(401);
  });

  test('creates a key shown once, stores only its hash', async () => {
    const res = await request(appAs(admin)).post('/api/keys').send({ name: 'ci-bot' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^clomp_live_[0-9a-f]{64}$/);

    const [, params] = mockPoolQuery.mock.calls[0];
    const storedHash = params[3];
    expect(storedHash).toBe(crypto.createHash('sha256').update(res.body.key).digest('hex'));
    expect(storedHash).not.toContain(res.body.key);
  });

  test('rejects creation without a name', async () => {
    expect((await request(appAs(admin)).post('/api/keys').send({})).status).toBe(400);
  });

  test('revokes keys instead of deleting them', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'k1' }] });
    const res = await request(appAs(admin)).delete('/api/keys/k1');
    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][0]).toContain('SET revoked_at = now()');
    expect(mockPoolQuery.mock.calls[0][0]).not.toContain('DELETE');
  });

  test('404 when revoking an unknown or already-revoked key', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect((await request(appAs(admin)).delete('/api/keys/ghost')).status).toBe(404);
  });
});

describe('attachApiKey middleware', () => {
  function keyApp() {
    const app = express();
    app.use(attachApiKey);
    app.get('/whoami', (req, res) => res.json({ apiKey: req.apiKey || null }));
    return app;
  }

  beforeEach(() => jest.clearAllMocks());

  test('resolves a valid key by hash and ignores invalid ones', async () => {
    const key = 'clomp_live_' + 'a'.repeat(64);
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    mockPoolQuery.mockImplementation(async (sql, params) => {
      if (params[0] === keyHash) return { rows: [{ id: 'k1', tenant_id: TENANT, name: 'ci-bot' }] };
      return { rows: [] };
    });

    const hit = await request(keyApp()).get('/whoami').set('X-API-Key', key);
    expect(hit.body.apiKey).toEqual({ id: 'k1', tenant_id: TENANT, name: 'ci-bot' });
    expect(mockPoolQuery.mock.calls[0][0]).toContain('revoked_at IS NULL');

    const miss = await request(keyApp()).get('/whoami').set('X-API-Key', 'clomp_live_bogus');
    expect(miss.body.apiKey).toBeNull();

    const none = await request(keyApp()).get('/whoami');
    expect(none.body.apiKey).toBeNull();
  });
});
