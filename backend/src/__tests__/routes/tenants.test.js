const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
const mockAppendEvent = jest.fn();

jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  // The operator (default) tenant is the admin's tenant in these tests.
  getDefaultTenantId: () => 'aaaaaaaa-0000-0000-0000-000000000001',
  TENANT_SLUG_PATTERN: jest.requireActual('../../database').TENANT_SLUG_PATTERN
}));
jest.mock('../../services/chain', () => ({
  appendEvent: (...args) => mockAppendEvent(...args)
}));

const tenantRoutes = require('../../routes/tenants');

const ADMIN_TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';

function appAs(principal) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    Object.assign(req, principal);
    next();
  });
  app.use('/api/tenants', tenantRoutes);
  return app;
}

const adminApp = () => appAs({ user: { id: 'u1', email: 'admin@x.se', role: 'admin', tenant_id: ADMIN_TENANT } });
const editorApp = () => appAs({ user: { id: 'u2', email: 'e@x.se', role: 'editor', tenant_id: ADMIN_TENANT } });
const apiKeyApp = () => appAs({ apiKey: { id: 'k1', name: 'ci-bot', tenant_id: ADMIN_TENANT } });
const anonApp = () => appAs({});

const tenantRow = (extra = {}) => ({
  id: OTHER_TENANT,
  name: 'acme',
  display_name: 'Acme Corp',
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...extra
});

describe('tenant routes', () => {
  const OLD_ENV = process.env.MULTI_TENANT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MULTI_TENANT = 'true';
    mockAppendEvent.mockResolvedValue({ sequence: 1 });
  });

  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = OLD_ENV;
  });

  describe('with MULTI_TENANT off', () => {
    test.each(['false', undefined])('every endpoint is 404 even for admins (%s)', async (value) => {
      if (value === undefined) delete process.env.MULTI_TENANT;
      else process.env.MULTI_TENANT = value;

      expect((await request(adminApp()).get('/api/tenants')).status).toBe(404);
      expect((await request(adminApp()).post('/api/tenants').send({ slug: 'acme', display_name: 'Acme' })).status).toBe(404);
      expect((await request(adminApp()).patch(`/api/tenants/${OTHER_TENANT}`).send({ display_name: 'X' })).status).toBe(404);
      expect((await request(adminApp()).delete(`/api/tenants/${OTHER_TENANT}`)).status).toBe(404);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  describe('access control', () => {
    test('requires a signed-in admin', async () => {
      expect((await request(anonApp()).get('/api/tenants')).status).toBe(401);
      expect((await request(editorApp()).get('/api/tenants')).status).toBe(403);
      // API keys are machine writers scoped to one tenant — never roster admins.
      expect((await request(apiKeyApp()).get('/api/tenants')).status).toBe(401);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('client-tenant admins cannot manage the roster (operator tenant only)', async () => {
      const clientAdmin = appAs({ user: { id: 'u9', email: 'boss@acme.example', role: 'admin', tenant_id: OTHER_TENANT } });
      expect((await request(clientAdmin).get('/api/tenants')).status).toBe(403);
      expect((await request(clientAdmin).post('/api/tenants').send({ slug: 'x', display_name: 'X' })).status).toBe(403);
      expect((await request(clientAdmin).delete(`/api/tenants/${ADMIN_TENANT}`)).status).toBe(403);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/tenants', () => {
    test('lists tenants with slug/display_name/active', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          tenantRow({ id: ADMIN_TENANT, name: 'default', display_name: null }),
          tenantRow({ active: false })
        ]
      });
      const res = await request(adminApp()).get('/api/tenants');
      expect(res.status).toBe(200);
      expect(res.body.tenants).toHaveLength(2);
      expect(res.body.tenants[0]).toMatchObject({ slug: 'default', display_name: 'default' });
      expect(res.body.tenants[1]).toMatchObject({ slug: 'acme', display_name: 'Acme Corp', active: false });
    });
  });

  describe('POST /api/tenants', () => {
    test('creates a tenant and records tenant.created on the admin tenant chain', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [tenantRow()] });

      const res = await request(adminApp()).post('/api/tenants').send({ slug: 'acme', display_name: 'Acme Corp' });
      expect(res.status).toBe(201);
      expect(res.body.tenant).toMatchObject({ slug: 'acme', display_name: 'Acme Corp', active: true });
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([expect.any(String), 'acme', 'Acme Corp']);
      expect(mockAppendEvent).toHaveBeenCalledWith(ADMIN_TENANT, expect.objectContaining({
        action: 'tenant.created',
        target: expect.objectContaining({ type: 'tenant', name: 'acme' })
      }));
    });

    test('409 when the slug already exists', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(adminApp()).post('/api/tenants').send({ slug: 'acme', display_name: 'Acme Corp' });
      expect(res.status).toBe(409);
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });

    test.each([
      [{ display_name: 'Acme' }, 'slug'],
      [{ slug: 'Bad Slug', display_name: 'Acme' }, 'slug'],
      [{ slug: '-acme', display_name: 'Acme' }, 'slug'],
      [{ slug: 'acme-', display_name: 'Acme' }, 'slug'],
      [{ slug: 'a'.repeat(64), display_name: 'Acme' }, 'slug'],
      [{ slug: 'acme' }, 'display_name'],
      [{ slug: 'acme', display_name: '   ' }, 'display_name'],
      [{ slug: 'acme', display_name: 'x'.repeat(201) }, 'display_name']
    ])('validates input %#', async (body, field) => {
      const res = await request(adminApp()).post('/api/tenants').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(field);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/tenants/:id', () => {
    test('renames the display name and records tenant.renamed', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [tenantRow({ display_name: 'Acme Corporation' })] });

      const res = await request(adminApp())
        .patch(`/api/tenants/${OTHER_TENANT}`)
        .send({ display_name: 'Acme Corporation' });
      expect(res.status).toBe(200);
      expect(res.body.tenant.display_name).toBe('Acme Corporation');
      expect(mockAppendEvent).toHaveBeenCalledWith(ADMIN_TENANT, expect.objectContaining({
        action: 'tenant.renamed'
      }));
    });

    test('404 on unknown id, 400 on missing display_name', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      expect((await request(adminApp()).patch(`/api/tenants/${OTHER_TENANT}`).send({ display_name: 'X' })).status).toBe(404);
      expect((await request(adminApp()).patch(`/api/tenants/${OTHER_TENANT}`).send({})).status).toBe(400);
    });
  });

  describe('DELETE /api/tenants/:id', () => {
    test('soft-deactivates and records tenant.deactivated', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [tenantRow({ active: false })] });

      const res = await request(adminApp()).delete(`/api/tenants/${OTHER_TENANT}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant.active).toBe(false);
      expect(mockPoolQuery.mock.calls[0][0]).toContain('UPDATE tenants SET active = $1');
      expect(mockPoolQuery.mock.calls[0][1][0]).toBe(false);
      expect(mockAppendEvent).toHaveBeenCalledWith(ADMIN_TENANT, expect.objectContaining({
        action: 'tenant.deactivated'
      }));
    });

    test('refuses to deactivate the admin\'s own tenant, even with a case-variant UUID', async () => {
      const res = await request(adminApp()).delete(`/api/tenants/${ADMIN_TENANT}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/own tenant/);
      // Postgres compares UUIDs case-insensitively; the guard must too.
      const upper = await request(adminApp()).delete(`/api/tenants/${ADMIN_TENANT.toUpperCase()}`);
      expect(upper.status).toBe(400);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('404 (not 500) on a malformed tenant id', async () => {
      expect((await request(adminApp()).delete('/api/tenants/not-a-uuid')).status).toBe(404);
      expect((await request(adminApp()).patch('/api/tenants/acme').send({ display_name: 'X' })).status).toBe(404);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('404 when already deactivated or unknown', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      expect((await request(adminApp()).delete(`/api/tenants/${OTHER_TENANT}`)).status).toBe(404);
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/tenants/:id/activate', () => {
    test('reactivates and records tenant.reactivated', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [tenantRow({ active: true })] });

      const res = await request(adminApp()).post(`/api/tenants/${OTHER_TENANT}/activate`);
      expect(res.status).toBe(200);
      expect(res.body.tenant.active).toBe(true);
      expect(mockAppendEvent).toHaveBeenCalledWith(ADMIN_TENANT, expect.objectContaining({
        action: 'tenant.reactivated'
      }));
    });

    test('404 when already active or unknown', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      expect((await request(adminApp()).post(`/api/tenants/${OTHER_TENANT}/activate`)).status).toBe(404);
    });
  });

  describe('error handling', () => {
    test('500 when the database fails', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('db down'));
      expect((await request(adminApp()).get('/api/tenants')).status).toBe(500);
    });
  });
});
