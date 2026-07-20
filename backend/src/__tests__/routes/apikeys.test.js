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
const K1 = 'bbbbbbbb-0000-0000-0000-000000000001';

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

  test('creates a key with an expiry and returns it', async () => {
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const res = await request(appAs(admin)).post('/api/keys').send({ name: 'ci-bot', expires_at: expires });
    expect(res.status).toBe(201);
    expect(res.body.expires_at).toBe(expires);

    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[5]).toBe(expires);
  });

  test('rejects a malformed or past expires_at', async () => {
    const bad = await request(appAs(admin)).post('/api/keys').send({ name: 'x', expires_at: 'not-a-date' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/ISO 8601/);

    const past = await request(appAs(admin))
      .post('/api/keys').send({ name: 'x', expires_at: '2020-01-01T00:00:00.000Z' });
    expect(past.status).toBe(400);
    expect(past.body.error).toMatch(/future/);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('rotates a key: revoke + replace in one atomic statement, new secret shown once', async () => {
    mockPoolQuery.mockImplementation(async () => ({
      rows: [{ id: 'new-id', name: 'ci-bot', expires_at: null }]
    }));

    const res = await request(appAs(admin)).post('/api/keys/' + K1 + '/rotate').send({});
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^clomp_live_[0-9a-f]{64}$/);
    expect(res.body.rotated_from).toBe(K1);
    expect(res.body.name).toBe('ci-bot');

    const [sql, params] = mockPoolQuery.mock.calls[0];
    // Single statement doing both the revoke and the insert.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(sql).toContain('SET revoked_at = now()');
    expect(sql).toContain('INSERT INTO api_keys');
    expect(params[0]).toBe(K1);
    expect(params[1]).toBe(TENANT);
    // Only the hash of the new secret is stored.
    expect(params[3]).toBe(crypto.createHash('sha256').update(res.body.key).digest('hex'));
  });

  test('rotate passes a new expiry through and validates it', async () => {
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'new-id', name: 'ci-bot', expires_at: expires }] });

    const res = await request(appAs(admin)).post('/api/keys/' + K1 + '/rotate').send({ expires_at: expires });
    expect(res.status).toBe(201);
    expect(mockPoolQuery.mock.calls[0][1][5]).toBe(expires);

    const bad = await request(appAs(admin)).post('/api/keys/' + K1 + '/rotate').send({ expires_at: 'garbage' });
    expect(bad.status).toBe(400);
  });

  test('404 when rotating an unknown, malformed or already-revoked key id', async () => {
    // Unknown-but-valid UUID: the CTE matches nothing.
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const unknown = 'cccccccc-0000-0000-0000-000000000009';
    expect((await request(appAs(admin)).post(`/api/keys/${unknown}/rotate`).send({})).status).toBe(404);

    // Malformed id: rejected before any query (no uuid cast error → 500).
    jest.clearAllMocks();
    expect((await request(appAs(admin)).post('/api/keys/ghost/rotate').send({})).status).toBe(404);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('revokes keys instead of deleting them', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'k1' }] });
    const res = await request(appAs(admin)).delete('/api/keys/' + K1);
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

  test('rejects expired keys at the SQL level, exactly like revoked ones', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const res = await request(keyApp()).get('/whoami').set('X-API-Key', 'clomp_live_' + 'b'.repeat(64));
    expect(res.body.apiKey).toBeNull();
    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('expires_at IS NULL OR expires_at > now()');
  });

  const KEY = 'clomp_live_' + 'a'.repeat(64);
  function resolveKeyWith(last_used_at) {
    mockPoolQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT')) {
        return { rows: [{ id: 'k1', tenant_id: TENANT, name: 'ci-bot', last_used_at }] };
      }
      return { rows: [] };
    });
  }

  test('stamps last_used_at on first use', async () => {
    resolveKeyWith(null);
    await request(keyApp()).get('/whoami').set('X-API-Key', KEY);

    const update = mockPoolQuery.mock.calls.find(([sql]) => sql.includes('UPDATE'));
    expect(update).toBeDefined();
    expect(update[0]).toContain('SET last_used_at = now()');
    // The SQL re-checks staleness so multiple instances stay throttled too,
    // driven by the same constant as the in-process check.
    expect(update[0]).toContain("last_used_at < now() - ($2 * interval '1 millisecond')");
    expect(update[1]).toEqual(['k1', 60 * 1000]);
  });

  test('throttles last_used_at updates to once a minute', async () => {
    resolveKeyWith(new Date(Date.now() - 5000).toISOString()); // fresh
    await request(keyApp()).get('/whoami').set('X-API-Key', KEY);
    expect(mockPoolQuery.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);

    jest.clearAllMocks();
    resolveKeyWith(new Date(Date.now() - 90 * 1000).toISOString()); // stale
    await request(keyApp()).get('/whoami').set('X-API-Key', KEY);
    expect(mockPoolQuery.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(true);
  });

  test('a failing last_used_at write does not break authentication', async () => {
    mockPoolQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT')) {
        return { rows: [{ id: 'k1', tenant_id: TENANT, name: 'ci-bot', last_used_at: null }] };
      }
      throw new Error('db hiccup');
    });
    const res = await request(keyApp()).get('/whoami').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toEqual({ id: 'k1', tenant_id: TENANT, name: 'ci-bot' });
  });
});
