const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  getDefaultTenantId: () => 'aaaaaaaa-0000-0000-0000-000000000001'
}));

const userRoutes = require('../../routes/users');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function appAs(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/users', userRoutes);
  return app;
}

const admin = { id: 'admin-1', email: 'a@x.se', role: 'admin', tenant_id: TENANT };
const editor = { id: 'editor-1', email: 'e@x.se', role: 'editor', tenant_id: TENANT };

describe('user routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  test('requires admin role', async () => {
    expect((await request(appAs(editor)).get('/api/users')).status).toBe(403);
    expect((await request(appAs(null)).get('/api/users')).status).toBe(401);
  });

  test('lists users scoped to the tenant', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'u1', email: 'x@x.se' }] });
    const res = await request(appAs(admin)).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([TENANT]);
  });

  test('creates a user with a one-time password (argon2 hash stored)', async () => {
    const res = await request(appAs(admin)).post('/api/users')
      .send({ email: 'New@User.se', name: 'New User', role: 'auditor' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@user.se');
    expect(res.body.initial_password).toHaveLength(16);
    const storedHash = mockPoolQuery.mock.calls[0][1][4];
    expect(storedHash).toMatch(/^\$argon2id\$/);
  });

  test('creates the user in the acting admin\'s tenant, never the default tenant', async () => {
    const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
    const otherAdmin = { id: 'admin-2', email: 'b@acme.example', role: 'admin', tenant_id: TENANT_B };
    const res = await request(appAs(otherAdmin)).post('/api/users')
      .send({ email: 'colleague@acme.example', name: 'Colleague', role: 'editor' });
    expect(res.status).toBe(201);
    expect(mockPoolQuery.mock.calls[0][1][1]).toBe(TENANT_B);
  });

  test('rejects invalid roles and duplicate emails', async () => {
    expect((await request(appAs(admin)).post('/api/users')
      .send({ email: 'x@x.se', name: 'X', role: 'superuser' })).status).toBe(400);

    const dup = new Error('duplicate');
    dup.code = '23505';
    mockPoolQuery.mockRejectedValueOnce(dup);
    expect((await request(appAs(admin)).post('/api/users')
      .send({ email: 'x@x.se', name: 'X', role: 'editor' })).status).toBe(409);
  });

  test('updates role/disabled but blocks self-demotion and self-disable', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'u2', role: 'auditor', disabled: true }] });
    const res = await request(appAs(admin)).patch('/api/users/u2').send({ disabled: true });
    expect(res.status).toBe(200);

    expect((await request(appAs(admin)).patch('/api/users/admin-1').send({ disabled: true })).status).toBe(400);
    expect((await request(appAs(admin)).patch('/api/users/admin-1').send({ role: 'editor' })).status).toBe(400);
  });

  test('reset-password revokes sessions and clears TOTP', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u2', email: 'x@x.se' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(appAs(admin)).post('/api/users/u2/reset-password');
    expect(res.status).toBe(200);
    expect(res.body.initial_password).toBeTruthy();
    expect(mockPoolQuery.mock.calls[0][0]).toContain('totp_enabled = false');
    expect(mockPoolQuery.mock.calls[1][0]).toContain('DELETE FROM sessions');
  });

  test('404 when the target user is in another tenant or missing', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect((await request(appAs(admin)).patch('/api/users/ghost').send({ role: 'editor' })).status).toBe(404);
    expect((await request(appAs(admin)).post('/api/users/ghost/reset-password')).status).toBe(404);
  });
});
