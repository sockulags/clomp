/**
 * Tenant scoping at the credential-resolution layer: a session or API key
 * resolves to exactly one tenant_id, deactivated tenants stop resolving,
 * and requestTenantId() only ever returns the caller's own tenant.
 */

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const { attachApiKey, requireAuth, requestTenantId, hashKey } = require('../../middleware/apikey');
const { attachSession } = require('../../middleware/session');

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function run(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (err) => (err ? reject(err) : resolve()));
  });
}

describe('tenant scoping in credential resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('attachApiKey', () => {
    test('resolves a key to its own tenant only, and only for active tenants', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'k1', tenant_id: TENANT_A, name: 'bot-a' }] });
      // Default for the fire-and-forget last_used_at UPDATE that follows.
      mockPoolQuery.mockResolvedValue({ rows: [] });
      const req = { headers: { 'x-api-key': 'clomp_live_abc' } };
      await run(attachApiKey, req);

      expect(req.apiKey).toEqual({ id: 'k1', tenant_id: TENANT_A, name: 'bot-a' });
      const [sql, params] = mockPoolQuery.mock.calls[0];
      // The lookup is by key hash alone — the tenant comes from the key row,
      // never from anything the caller supplies.
      expect(params).toEqual([hashKey('clomp_live_abc')]);
      expect(sql).toContain('revoked_at IS NULL');
      // Soft-deactivated tenants must not resolve.
      expect(sql).toContain('t.active = true');
    });

    test('leaves req.apiKey unset when the key does not resolve (revoked, unknown, or inactive tenant)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const req = { headers: { 'x-api-key': 'clomp_live_dead' } };
      await run(attachApiKey, req);
      expect(req.apiKey).toBeUndefined();
    });
  });

  describe('attachSession', () => {
    test('requires the user\'s tenant to be active', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      const req = { headers: { cookie: 'clomp_session=tok' } };
      await run(attachSession, req);

      const [sql] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('JOIN tenants t ON t.id = u.tenant_id');
      expect(sql).toContain('t.active = true');
      expect(req.user).toBeUndefined();
    });
  });

  describe('requestTenantId', () => {
    test('returns the API key\'s tenant for machine callers', () => {
      expect(requestTenantId({ apiKey: { id: 'k1', tenant_id: TENANT_A } })).toBe(TENANT_A);
    });

    test('returns the session user\'s tenant for humans', () => {
      expect(requestTenantId({ user: { id: 'u1', tenant_id: TENANT_B } })).toBe(TENANT_B);
    });

    test('returns null when unauthenticated', () => {
      expect(requestTenantId({})).toBeNull();
    });
  });

  describe('requireAuth', () => {
    test('rejects unauthenticated requests with 401', () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      requireAuth()({}, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
