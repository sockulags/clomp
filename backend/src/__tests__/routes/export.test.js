const request = require('supertest');
const express = require('express');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
const mockVerifyChain = jest.fn();

jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));
jest.mock('../../services/chain', () => ({
  rowToEvent: jest.requireActual('../../services/chain').rowToEvent,
  verifyChain: (...args) => mockVerifyChain(...args)
}));

const exportRoutes = require('../../routes/export');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function makeApp() {
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 'u1', role: 'auditor', tenant_id: TENANT };
    next();
  });
  app.use('/api/export', exportRoutes);
  return app;
}

const eventRow = (sequence, extra = {}) => ({
  id: `e${sequence}`, tenant_id: TENANT, sequence,
  occurred_at: new Date('2026-07-01T00:00:00Z'), recorded_at: new Date('2026-07-01T00:00:01Z'),
  actor: { type: 'user', id: 'u1' }, action: 'patch.applied',
  target: null, context: null, evidence: null,
  prev_hash: '0'.repeat(64), hash: `${sequence}`.repeat(64).slice(0, 64),
  ...extra
});

const checkpointRow = {
  tenant_id: TENANT, sequence: '2', hash: 'ab'.repeat(32),
  signature: 'c2ln', public_key: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n',
  signed_at: new Date('2026-07-13T02:00:00Z')
};

describe('export routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyChain.mockResolvedValue({ intact: true, verified: 2 });
  });

  test('JSONL export contains event and checkpoint lines', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [eventRow(1), eventRow(2)] }) // events
      .mockResolvedValueOnce({ rows: [checkpointRow] }); // checkpoints

    const res = await request(makeApp()).get('/api/export/jsonl');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const lines = res.text.trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(3);
    expect(lines[0].type).toBe('event');
    expect(lines[0].sequence).toBe(1);
    expect(lines[0].occurred_at).toBe('2026-07-01T00:00:00.000Z');
    expect(lines[2].type).toBe('checkpoint');
    expect(lines[2].sequence).toBe(2);
    expect(lines[2].signed_at).toBe('2026-07-13T02:00:00.000Z');
  });

  test('JSONL export applies the date range in SQL', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await request(makeApp()).get('/api/export/jsonl?from=2026-01-01&to=2026-06-30');
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('occurred_at >= $2');
    expect(sql).toContain('occurred_at <= $3');
    expect(params[0]).toBe(TENANT);
  });

  test('PDF report is a real PDF and reflects chain status', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          eventRow(1),
          eventRow(2, { action: 'made.up.action', evidence: [{ filename: 'x.txt', sha256: 'a'.repeat(64), size: 5 }] })
        ]
      })
      .mockResolvedValueOnce({ rows: [{ sequence: '2', signed_at: new Date('2026-07-13T02:00:00Z') }] });

    const res = await request(makeApp()).get('/api/export/report').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(mockVerifyChain).toHaveBeenCalledWith(TENANT);
  });

  test('requires authentication', async () => {
    const app = express();
    app.use('/api/export', exportRoutes);
    expect((await request(app).get('/api/export/jsonl')).status).toBe(401);
    expect((await request(app).get('/api/export/report')).status).toBe(401);
  });
});
