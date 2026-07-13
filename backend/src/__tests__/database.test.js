jest.mock('../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn()
}));

// Shared pg mocks
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

describe('Database', () => {
  let database;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://user:secret@localhost:5432/testdb';
    mockPgPool.connect.mockResolvedValue(mockPgClient);
    mockPgPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockPgPool.end.mockResolvedValue(undefined);
    mockPgClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

    database = require('../database');
    await database.initDatabase();
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  test('initDatabase creates tables and indexes', () => {
    expect(mockPgPool.connect).toHaveBeenCalled();
    expect(mockPgClient.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS services')
    );
    expect(mockPgClient.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS logs')
    );
    expect(mockPgClient.query).toHaveBeenCalledWith(
      expect.stringContaining('idx_logs_correlation_id')
    );
    expect(mockPgClient.release).toHaveBeenCalled();
  });

  test('initDatabase throws without DATABASE_URL', async () => {
    jest.resetModules();
    delete process.env.DATABASE_URL;
    const freshDatabase = require('../database');
    await expect(freshDatabase.initDatabase()).rejects.toThrow(/DATABASE_URL/);
  });

  test('getPool returns the shared pool', () => {
    expect(database.getPool()).toBe(mockPgPool);
  });

  test('getPool throws if pool is not initialized', () => {
    jest.resetModules();
    const freshDatabase = require('../database');
    expect(() => freshDatabase.getPool()).toThrow(/not initialized/);
  });

  test('initDatabase rejects when connection fails', async () => {
    jest.resetModules();
    mockPgPool.connect.mockRejectedValueOnce(new Error('connection refused'));
    const freshDatabase = require('../database');
    await expect(freshDatabase.initDatabase()).rejects.toThrow('connection refused');
  });

  test('run converts placeholders and reports changes', (done) => {
    mockPgPool.query.mockResolvedValue({ rows: [], rowCount: 2 });
    const db = database.getDatabase();

    db.run('UPDATE logs SET level = ? WHERE service = ?', ['info', 'svc'], function (err) {
      expect(err).toBeNull();
      expect(this.changes).toBe(2);
      expect(mockPgPool.query).toHaveBeenCalledWith(
        'UPDATE logs SET level = $1 WHERE service = $2',
        ['info', 'svc']
      );
      done();
    });
  });

  test('run passes errors to the callback', (done) => {
    mockPgPool.query.mockRejectedValue(new Error('boom'));
    const db = database.getDatabase();

    db.run('DELETE FROM logs WHERE id = ?', ['x'], (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });

  test('get returns the first row or null', (done) => {
    mockPgPool.query.mockResolvedValue({ rows: [{ id: 'a' }], rowCount: 1 });
    const db = database.getDatabase();

    db.get('SELECT * FROM logs WHERE id = ?', ['a'], (err, row) => {
      expect(err).toBeNull();
      expect(row).toEqual({ id: 'a' });

      mockPgPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      db.get('SELECT * FROM logs WHERE id = ?', ['b'], (err2, row2) => {
        expect(err2).toBeNull();
        expect(row2).toBeNull();
        done();
      });
    });
  });

  test('get passes errors to the callback', (done) => {
    mockPgPool.query.mockRejectedValue(new Error('boom'));
    const db = database.getDatabase();

    db.get('SELECT 1', [], (err, row) => {
      expect(err).toBeInstanceOf(Error);
      expect(row).toBeNull();
      done();
    });
  });

  test('all returns all rows', (done) => {
    mockPgPool.query.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 });
    const db = database.getDatabase();

    db.all('SELECT * FROM logs WHERE service = ?', ['svc'], (err, rows) => {
      expect(err).toBeNull();
      expect(rows).toHaveLength(2);
      done();
    });
  });

  test('all passes errors to the callback', (done) => {
    mockPgPool.query.mockRejectedValue(new Error('boom'));
    const db = database.getDatabase();

    db.all('SELECT 1', [], (err, rows) => {
      expect(err).toBeInstanceOf(Error);
      expect(rows).toBeNull();
      done();
    });
  });

  test('closeDatabase ends the pool', async () => {
    await database.closeDatabase();
    expect(mockPgPool.end).toHaveBeenCalled();
  });
});
