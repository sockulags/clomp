const os = require('os');
const path = require('path');
const fs = require('fs');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

let store;

const mockPool = {
  query: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT sequence, hash FROM events')) {
      const [tenantId] = params;
      const rows = store.events
        .filter(e => e.tenant_id === tenantId)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 1);
      return { rows };
    }
    if (sql.includes('INSERT INTO checkpoints')) {
      store.checkpoints.push(params);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  })
};

jest.mock('../../database', () => ({
  getPool: () => mockPool
}));

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
let tmpKeyDir;
let checkpoints;

describe('checkpoints service', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clomp-keys-'));
    process.env.KEY_DIR = tmpKeyDir;
    store = { events: [], checkpoints: [] };
    checkpoints = require('../../services/checkpoints');
  });

  afterEach(() => {
    delete process.env.KEY_DIR;
    try {
      fs.rmSync(tmpKeyDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup on Windows
    }
  });

  test('generates a keypair on first use and reuses it after', () => {
    const first = checkpoints.ensureSigningKeys();
    expect(fs.existsSync(path.join(tmpKeyDir, 'checkpoint-ed25519.pem'))).toBe(true);
    expect(first.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    const again = checkpoints.ensureSigningKeys();
    expect(again.publicKeyPem).toBe(first.publicKeyPem);
  });

  test('createCheckpoint returns null on an empty chain', async () => {
    expect(await checkpoints.createCheckpoint(TENANT)).toBeNull();
    expect(store.checkpoints).toHaveLength(0);
  });

  test('createCheckpoint signs the chain tip and the signature verifies', async () => {
    store.events.push({ tenant_id: TENANT, sequence: 7, hash: 'ab'.repeat(32) });

    const cp = await checkpoints.createCheckpoint(TENANT);
    expect(cp.sequence).toBe(7);
    expect(cp.hash).toBe('ab'.repeat(32));
    expect(store.checkpoints).toHaveLength(1);

    expect(checkpoints.verifyCheckpointSignature(cp)).toBe(true);
  });

  test('a tampered checkpoint fails signature verification', async () => {
    store.events.push({ tenant_id: TENANT, sequence: 3, hash: 'cd'.repeat(32) });
    const cp = await checkpoints.createCheckpoint(TENANT);

    expect(checkpoints.verifyCheckpointSignature({ ...cp, sequence: 4 })).toBe(false);
    expect(checkpoints.verifyCheckpointSignature({ ...cp, hash: 'ef'.repeat(32) })).toBe(false);
    expect(checkpoints.verifyCheckpointSignature({ ...cp, signed_at: '2030-01-01T00:00:00.000Z' })).toBe(false);
  });
});
