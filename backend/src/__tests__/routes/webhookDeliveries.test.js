const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const webhookDeliveryRoutes = require('../../routes/webhookDeliveries');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function appAs(principal) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    Object.assign(req, principal);
    next();
  });
  app.use('/api/webhook-deliveries', webhookDeliveryRoutes);
  return app;
}

const adminApp = () => appAs({ user: { id: 'u1', email: 'admin@x.se', role: 'admin', tenant_id: TENANT } });
const auditorApp = () => appAs({ user: { id: 'u3', email: 'a@x.se', role: 'auditor', tenant_id: TENANT } });
const apiKeyApp = () => appAs({ apiKey: { id: 'k1', name: 'ci-bot', tenant_id: TENANT } });
const anonApp = () => appAs({});

const deliveryRow = (extra = {}) => ({
  id: '11',
  tenant_id: TENANT,
  kind: 'event',
  url: 'https://hooks.example.com/clomp',
  payload_summary: { event_id: 'e1', sequence: 7, action: 'incident.opened' },
  status: 'pending',
  attempt_count: 2,
  last_error: 'Webhook responded 502',
  next_attempt_at: new Date('2026-07-14T10:02:00Z'),
  delivered_at: null,
  created_at: new Date('2026-07-14T10:00:00Z'),
  updated_at: new Date('2026-07-14T10:01:00Z'),
  ...extra
});

describe('webhook delivery routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/webhook-deliveries', () => {
    test('lists deliveries newest first for the admin tenant', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [deliveryRow()] });

      const res = await request(adminApp()).get('/api/webhook-deliveries');
      expect(res.status).toBe(200);
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body.deliveries[0]).toMatchObject({
        id: 11,
        kind: 'event',
        status: 'pending',
        attempt_count: 2,
        last_error: 'Webhook responded 502',
        payload_summary: { sequence: 7, action: 'incident.opened' }
      });
      expect(res.body.has_more).toBe(false);
      expect(res.body.next_before_id).toBeNull();

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY id DESC');
      expect(params[0]).toBe(TENANT);
    });

    test('filters by status and kind', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(adminApp()).get('/api/webhook-deliveries?status=failed&kind=anchor');
      expect(res.status).toBe(200);

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('status = $2');
      expect(sql).toContain('kind = $3');
      expect(params).toEqual([TENANT, 'failed', 'anchor', 51]);
    });

    test('keyset-paginates with before_id', async () => {
      const rows = [deliveryRow({ id: '30' }), deliveryRow({ id: '29' }), deliveryRow({ id: '28' })];
      mockPoolQuery.mockResolvedValueOnce({ rows });

      const res = await request(adminApp()).get('/api/webhook-deliveries?limit=2&before_id=31');
      expect(res.status).toBe(200);
      expect(res.body.deliveries).toHaveLength(2);
      expect(res.body.has_more).toBe(true);
      expect(res.body.next_before_id).toBe(29);

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('id < $2');
      expect(params).toEqual([TENANT, 31, 3]);
    });

    test.each([
      ['status=shipped', 'status'],
      ['kind=carrier-pigeon', 'kind'],
      ['before_id=abc', 'before_id'],
      ['before_id=-1', 'before_id']
    ])('rejects invalid query %s', async (query, field) => {
      const res = await request(adminApp()).get(`/api/webhook-deliveries?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(field);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('is admin-only: auditors 403, API keys and anonymous 401', async () => {
      expect((await request(auditorApp()).get('/api/webhook-deliveries')).status).toBe(403);
      expect((await request(apiKeyApp()).get('/api/webhook-deliveries')).status).toBe(401);
      expect((await request(anonApp()).get('/api/webhook-deliveries')).status).toBe(401);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('500 on database errors', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('db down'));
      expect((await request(adminApp()).get('/api/webhook-deliveries')).status).toBe(500);
    });
  });
});
