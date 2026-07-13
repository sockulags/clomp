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
    expect(mockPoolQuery.mock.calls[0][0]).toContain('ON CONFLICT (sha256) DO NOTHING');
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
});
