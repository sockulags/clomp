const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockAppendEvent = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('../../services/chain', () => ({
  appendEvent: (...args) => mockAppendEvent(...args),
  rowToEvent: jest.requireActual('../../services/chain').rowToEvent
}));

jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const eventRoutes = require('../../routes/events');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function appAs(principal) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    Object.assign(req, principal);
    next();
  });
  app.use('/api/events', eventRoutes);
  return app;
}

const editorApp = () => appAs({ user: { id: 'u1', email: 'e@x.se', role: 'editor', tenant_id: TENANT } });
const auditorApp = () => appAs({ user: { id: 'u2', email: 'a@x.se', role: 'auditor', tenant_id: TENANT } });
const apiKeyApp = () => appAs({ apiKey: { id: 'k1', name: 'ci-bot', tenant_id: TENANT } });
const anonApp = () => appAs({});

const VALID_BODY = {
  action: 'patch.applied',
  actor: { type: 'user', id: 'lucas' },
  target: { type: 'system', id: 'web-01' }
};

describe('event routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppendEvent.mockResolvedValue({ id: 'e1', sequence: 1, hash: 'h', action: 'patch.applied' });
  });

  describe('POST /api/events', () => {
    test('appends a valid event as editor and stamps recorded_by', async () => {
      const res = await request(editorApp()).post('/api/events').send(VALID_BODY);
      expect(res.status).toBe(201);
      expect(res.body.known_action).toBe(true);
      expect(mockAppendEvent).toHaveBeenCalledWith(TENANT, expect.objectContaining({
        action: 'patch.applied',
        actor: expect.objectContaining({
          id: 'lucas',
          recorded_by: { via: 'user', id: 'u1', email: 'e@x.se' }
        })
      }));
    });

    test('accepts API-key writers and stamps the key identity', async () => {
      const res = await request(apiKeyApp()).post('/api/events').send(VALID_BODY);
      expect(res.status).toBe(201);
      expect(mockAppendEvent).toHaveBeenCalledWith(TENANT, expect.objectContaining({
        actor: expect.objectContaining({
          recorded_by: { via: 'api_key', id: 'k1', name: 'ci-bot' }
        })
      }));
    });

    test('flags unknown actions but still accepts them', async () => {
      const res = await request(editorApp()).post('/api/events')
        .send({ ...VALID_BODY, action: 'custom.internal.check' });
      expect(res.status).toBe(201);
      expect(res.body.known_action).toBe(false);
    });

    test('rejects auditors (read-only role)', async () => {
      const res = await request(auditorApp()).post('/api/events').send(VALID_BODY);
      expect(res.status).toBe(403);
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });

    test('rejects anonymous requests', async () => {
      const res = await request(anonApp()).post('/api/events').send(VALID_BODY);
      expect(res.status).toBe(401);
    });

    test.each([
      [{ ...VALID_BODY, action: 'NotNamespaced' }, /action/],
      [{ ...VALID_BODY, actor: { type: 'user' } }, /actor/],
      [{ ...VALID_BODY, evidence: [{ sha256: 'short' }] }, /sha256/],
      [{ ...VALID_BODY, evidence: { sha256: 'x' } }, /evidence must be an array/],
      [{ ...VALID_BODY, occurred_at: 'not-a-date' }, /occurred_at/],
      [{ ...VALID_BODY, occurred_at: new Date(Date.now() + 7_200_000).toISOString() }, /future/]
    ])('validates bad bodies (%#)', async (body, errorPattern) => {
      const res = await request(editorApp()).post('/api/events').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(errorPattern);
    });

    test('rejects oversized context', async () => {
      const res = await request(editorApp()).post('/api/events')
        .send({ ...VALID_BODY, context: { blob: 'x'.repeat(33 * 1024) } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/context exceeds/);
    });

    test('returns 500 when the chain append fails', async () => {
      mockAppendEvent.mockRejectedValue(new Error('db down'));
      const res = await request(editorApp()).post('/api/events').send(VALID_BODY);
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/events', () => {
    const row = (sequence) => ({
      id: `e${sequence}`, tenant_id: TENANT, sequence,
      occurred_at: new Date('2026-07-01T00:00:00Z'), recorded_at: new Date('2026-07-01T00:00:01Z'),
      actor: { type: 'user', id: 'u1' }, action: 'patch.applied',
      target: null, context: null, evidence: null,
      prev_hash: '0'.repeat(64), hash: '1'.repeat(64)
    });

    test('lists events with keyset pagination metadata', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row(3), row(2), row(1)] });
      const res = await request(auditorApp()).get('/api/events?limit=2');
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.has_more).toBe(true);
      expect(res.body.next_before_sequence).toBe(2);
      // The SQL must contain a real LIMIT, not JS slicing of the full table.
      expect(mockPoolQuery.mock.calls[0][0]).toContain('LIMIT');
    });

    test('applies filters as SQL conditions', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await request(auditorApp())
        .get('/api/events?action=patch.applied&actor_id=lucas&from=2026-01-01&to=2026-12-31&before_sequence=100');
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('action = $2');
      expect(sql).toContain("actor->>'id' = $3");
      expect(sql).toContain('occurred_at >= $4');
      expect(sql).toContain('occurred_at <= $5');
      expect(sql).toContain('sequence < $6');
      expect(params[0]).toBe(TENANT);
      expect(params[1]).toBe('patch.applied');
    });

    test('applies q as one ILIKE condition across all searchable fields', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row(1)] });
      const res = await request(auditorApp()).get('/api/events').query({ q: 'web-01' });
      expect(res.status).toBe(200);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('action ILIKE $2');
      expect(sql).toContain("actor->>'id' ILIKE $2");
      expect(sql).toContain("actor->>'type' ILIKE $2");
      expect(sql).toContain("target->>'id' ILIKE $2");
      expect(sql).toContain("target->>'type' ILIKE $2");
      expect(sql).toContain('context::text ILIKE $2');
      expect(params).toEqual([TENANT, '%web-01%', 51]);
    });

    test('composes q with filters and keyset pagination', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await request(auditorApp())
        .get('/api/events')
        .query({ q: 'deploy', action: 'patch.applied', actor_id: 'lucas', before_sequence: 42 });
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('action ILIKE $2');
      expect(sql).toContain('action = $3');
      expect(sql).toContain("actor->>'id' = $4");
      expect(sql).toContain('sequence < $5');
      expect(params).toEqual([TENANT, '%deploy%', 'patch.applied', 'lucas', 42, 51]);
    });

    test('escapes LIKE wildcards in q so they match literally', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await request(auditorApp()).get('/api/events').query({ q: '50%_\\done' });
      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[1]).toBe('%50\\%\\_\\\\done%');
    });

    test('rejects a non-string or over-long q with 400', async () => {
      const repeated = await request(auditorApp()).get('/api/events?q=web&q=db');
      expect(repeated.status).toBe(400);
      const tooLong = await request(auditorApp()).get('/api/events').query({ q: 'x'.repeat(201) });
      expect(tooLong.status).toBe(400);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('scopes reads and writes to the caller\'s own tenant — a tenant-B key never sees tenant A', async () => {
      const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
      const tenantBKey = appAs({ apiKey: { id: 'k2', name: 'other-org-bot', tenant_id: TENANT_B } });

      // Reads: the SQL is always filtered by the principal's tenant_id, and
      // there is no request parameter that can select another tenant.
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await request(tenantBKey).get('/api/events?tenant_id=' + TENANT);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('tenant_id = $1');
      expect(params[0]).toBe(TENANT_B);
      expect(params).not.toContain(TENANT);

      // Writes: events are appended to the key's own chain.
      await request(tenantBKey).post('/api/events').send(VALID_BODY);
      expect(mockAppendEvent).toHaveBeenCalledWith(TENANT_B, expect.anything());

      // Single-event fetch is tenant-scoped too.
      await request(tenantBKey).get('/api/events/1');
      const singleCall = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1];
      expect(singleCall[1][0]).toBe(TENANT_B);
    });

    test('serves the action catalog', async () => {
      const res = await request(auditorApp()).get('/api/events/catalog');
      expect(res.status).toBe(200);
      expect(res.body.actions.length).toBeGreaterThan(10);
    });
  });

  describe('GET /api/events/:sequence', () => {
    test('returns a single event', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{
          id: 'e5', tenant_id: TENANT, sequence: '5',
          occurred_at: new Date('2026-07-01T00:00:00Z'), recorded_at: new Date('2026-07-01T00:00:01Z'),
          actor: { type: 'user', id: 'u1' }, action: 'patch.applied',
          target: null, context: null, evidence: null,
          prev_hash: '0'.repeat(64), hash: '1'.repeat(64)
        }]
      });
      const res = await request(auditorApp()).get('/api/events/5');
      expect(res.status).toBe(200);
      expect(res.body.event.sequence).toBe(5);
      expect(res.body.event.occurred_at).toBe('2026-07-01T00:00:00.000Z');
    });

    test('404 on missing event, 400 on bad sequence', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      expect((await request(auditorApp()).get('/api/events/999')).status).toBe(404);
      expect((await request(auditorApp()).get('/api/events/0')).status).toBe(400);
    });
  });
});
