const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
let tmpDir;
let evidenceRoutes;

function appAs(user) {
  const app = express();
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/evidence', evidenceRoutes);
  return app;
}

const editor = { id: 'u1', email: 'e@x.se', role: 'editor', tenant_id: TENANT };
const auditor = { id: 'u2', email: 'a@x.se', role: 'auditor', tenant_id: TENANT };

describe('evidence routes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clomp-evidence-'));
    process.env.EVIDENCE_DIR = tmpDir;
    mockPoolQuery.mockResolvedValue({ rows: [] });
    evidenceRoutes = require('../../routes/evidence');
  });

  afterEach(() => {
    delete process.env.EVIDENCE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup on Windows
    }
  });

  test('uploads a file, stores it content-addressed and returns its sha256', async () => {
    const content = Buffer.from('quarterly access review minutes');
    const expectedSha = crypto.createHash('sha256').update(content).digest('hex');

    const res = await request(appAs(editor))
      .post('/api/evidence')
      .attach('file', content, 'review-q3.txt');

    expect(res.status).toBe(201);
    expect(res.body.sha256).toBe(expectedSha);
    expect(res.body.filename).toBe('review-q3.txt');

    const storedPath = path.join(tmpDir, expectedSha.slice(0, 2), expectedSha);
    expect(fs.readFileSync(storedPath).equals(content)).toBe(true);
    expect(mockPoolQuery.mock.calls[0][0]).toContain('ON CONFLICT (tenant_id, sha256) DO NOTHING');
    expect(mockPoolQuery.mock.calls[0][1][0]).toBe(TENANT);
  });

  test('rejects uploads without a file and from read-only roles', async () => {
    expect((await request(appAs(editor)).post('/api/evidence')).status).toBe(400);
    expect((await request(appAs(auditor))
      .post('/api/evidence')
      .attach('file', Buffer.from('x'), 'x.txt')).status).toBe(403);
  });

  test('downloads stored evidence with the original filename', async () => {
    const content = Buffer.from('pdf-bytes-here');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    fs.mkdirSync(path.join(tmpDir, sha.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, sha.slice(0, 2), sha), content);
    mockPoolQuery.mockResolvedValue({ rows: [{ filename: 'report.pdf', content_type: 'application/pdf' }] });

    const res = await request(appAs(auditor)).get(`/api/evidence/${sha}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('report.pdf');
    expect(Buffer.from(res.body).equals(content)).toBe(true);
  });

  test('404 for unknown hashes, 400 for malformed ones', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect((await request(appAs(auditor)).get('/api/evidence/' + 'f'.repeat(64))).status).toBe(404);
    expect((await request(appAs(auditor)).get('/api/evidence/nothex')).status).toBe(400);
  });

  test('a tenant cannot download another tenant s evidence, even with the exact hash', async () => {
    // The bytes exist on disk — storage is shared and content-addressed — so
    // the only thing standing between tenant B and tenant A's file is the
    // tenant predicate in the lookup.
    const content = Buffer.from('tenant A internal incident report');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    fs.mkdirSync(path.join(tmpDir, sha.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, sha.slice(0, 2), sha), content);

    // The row belongs to tenant A only.
    mockPoolQuery.mockImplementation((_sql, params) =>
      Promise.resolve({
        rows: params[0] === TENANT ? [{ filename: 'incident.pdf', content_type: 'application/pdf' }] : []
      })
    );

    const owner = await request(appAs(auditor)).get(`/api/evidence/${sha}`);
    expect(owner.status).toBe(200);

    const otherTenant = { id: 'u9', email: 'b@other.se', role: 'auditor', tenant_id: OTHER_TENANT };
    const outsider = await request(appAs(otherTenant)).get(`/api/evidence/${sha}`);
    // 404, not 403: the endpoint must not confirm the file exists at all.
    expect(outsider.status).toBe(404);
    expect(outsider.body.error).toBe('Evidence not found');

    const scopedQuery = mockPoolQuery.mock.calls.at(-1);
    expect(scopedQuery[0]).toContain('tenant_id = $1');
    expect(scopedQuery[1]).toEqual([OTHER_TENANT, sha]);
  });

  test('two tenants uploading the same bytes each get their own metadata row', async () => {
    const content = Buffer.from('the same policy pdf, uploaded by both');
    const sha = crypto.createHash('sha256').update(content).digest('hex');

    const first = await request(appAs(editor))
      .post('/api/evidence')
      .attach('file', content, 'policy-a.pdf');
    const secondEditor = { id: 'u8', email: 'e@other.se', role: 'editor', tenant_id: OTHER_TENANT };
    const second = await request(appAs(secondEditor))
      .post('/api/evidence')
      .attach('file', content, 'policy-b.pdf');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // One blob on disk...
    const storedPath = path.join(tmpDir, sha.slice(0, 2), sha);
    expect(fs.existsSync(storedPath)).toBe(true);
    expect(fs.readdirSync(path.join(tmpDir, sha.slice(0, 2)))).toEqual([sha]);

    // ...but a row per tenant, each keeping its own uploader and filename.
    const inserts = mockPoolQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO evidence_files'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1].slice(0, 3)).toEqual([TENANT, sha, 'policy-a.pdf']);
    expect(inserts[1][1].slice(0, 3)).toEqual([OTHER_TENANT, sha, 'policy-b.pdf']);
    expect(inserts[0][1][5]).toBe('e@x.se');
    expect(inserts[1][1][5]).toBe('e@other.se');
  });
});
