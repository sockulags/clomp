jest.mock('../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPgClient = {
  query: jest.fn(),
  release: jest.fn()
};

const mockPgPool = {
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn()
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPgPool)
}));

const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('database', () => {
  let database;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://user:secret@localhost:5432/testdb';
    mockPgPool.connect.mockResolvedValue(mockPgClient);
    mockPgPool.end.mockResolvedValue(undefined);
    mockPgClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT id FROM tenants')) {
        return { rows: [{ id: TENANT_ID }] };
      }
      return { rows: [], rowCount: 0 };
    });

    database = require('../database');
    await database.initDatabase();
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  test('initDatabase creates the events schema with append-only trigger', () => {
    expect(mockPgPool.connect).toHaveBeenCalled();
    const schemaSql = mockPgClient.query.mock.calls[0][0];
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS events');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS checkpoints');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(schemaSql).toContain('events are append-only');
    expect(schemaSql).toContain('BEFORE UPDATE OR DELETE ON events');
    expect(mockPgClient.release).toHaveBeenCalled();
  });

  test('initDatabase ensures the default tenant and exposes its id', () => {
    expect(database.getDefaultTenantId()).toBe(TENANT_ID);
    const insertCall = mockPgClient.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO tenants'));
    expect(insertCall).toBeTruthy();
    expect(String(insertCall[0])).toContain('ON CONFLICT (name) DO NOTHING');
  });

  test('initDatabase throws without DATABASE_URL', async () => {
    jest.resetModules();
    delete process.env.DATABASE_URL;
    const freshDatabase = require('../database');
    await expect(freshDatabase.initDatabase()).rejects.toThrow(/DATABASE_URL/);
  });

  test('getPool/getDefaultTenantId throw before initialization', () => {
    jest.resetModules();
    const freshDatabase = require('../database');
    expect(() => freshDatabase.getPool()).toThrow(/not initialized/);
    expect(() => freshDatabase.getDefaultTenantId()).toThrow(/not initialized/);
  });

  test('initDatabase rejects when the connection fails', async () => {
    jest.resetModules();
    mockPgPool.connect.mockRejectedValueOnce(new Error('connection refused'));
    const freshDatabase = require('../database');
    await expect(freshDatabase.initDatabase()).rejects.toThrow('connection refused');
  });

  test('closeDatabase ends the pool and resets state', async () => {
    await database.closeDatabase();
    expect(mockPgPool.end).toHaveBeenCalled();
    expect(() => database.getPool()).toThrow(/not initialized/);
  });
});
