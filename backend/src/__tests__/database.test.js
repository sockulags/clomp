const os = require('os');
const path = require('path');

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

// Shared sqlite3 mocks
const mockSqliteStmt = {
  run: jest.fn((params, callback) => {
    if (callback) callback.call({ changes: 1 }, null);
  }),
  finalize: jest.fn((callback) => {
    if (callback) callback(null);
  })
};

const mockSqliteDb = {
  run: jest.fn(function (sql, paramsOrCb, cb) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    if (callback) callback.call({ changes: 1 }, null);
  }),
  get: jest.fn((sql, params, callback) => callback(null, { value: 1 })),
  all: jest.fn((sql, params, callback) => callback(null, [{ value: 1 }])),
  serialize: jest.fn((fn) => fn()),
  prepare: jest.fn(() => mockSqliteStmt),
  close: jest.fn((callback) => callback(null))
};

jest.mock('sqlite3', () => ({
  verbose: () => ({
    Database: jest.fn(function (dbPath, callback) {
      process.nextTick(() => callback(null));
      return mockSqliteDb;
    })
  })
}));

describe('Database (PostgreSQL mode)', () => {
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

  test('getDatabaseType returns postgres', () => {
    expect(database.getDatabaseType()).toBe('postgres');
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

  test('serialize invokes the given function', () => {
    const db = database.getDatabase();
    const fn = jest.fn();
    db.serialize(fn);
    expect(fn).toHaveBeenCalled();
  });

  test('prepare returns a statement that runs against the pool', (done) => {
    mockPgPool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const db = database.getDatabase();
    const stmt = db.prepare('INSERT INTO logs (id, message) VALUES (?, ?)');

    stmt.run(['id-1', 'hello'], function (err) {
      expect(err).toBeNull();
      expect(this.changes).toBe(1);
      expect(mockPgPool.query).toHaveBeenCalledWith(
        'INSERT INTO logs (id, message) VALUES ($1, $2)',
        ['id-1', 'hello']
      );
      stmt.finalize((finalizeErr) => {
        expect(finalizeErr).toBeNull();
        done();
      });
    });
  });

  test('prepared statement passes errors to the callback', (done) => {
    mockPgPool.query.mockRejectedValue(new Error('boom'));
    const db = database.getDatabase();
    const stmt = db.prepare('INSERT INTO logs (id) VALUES (?)');

    stmt.run(['id-1'], (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });

  test('transaction helpers use a dedicated client', async () => {
    const db = database.getDatabase();

    const client = await db.beginTransaction();
    expect(client).toBe(mockPgClient);
    expect(mockPgClient.query).toHaveBeenCalledWith('BEGIN');

    await db.commitTransaction(client);
    expect(mockPgClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockPgClient.release).toHaveBeenCalled();

    const client2 = await db.beginTransaction();
    await db.rollbackTransaction(client2);
    expect(mockPgClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('closeDatabase ends the pool', async () => {
    await database.closeDatabase();
    expect(mockPgPool.end).toHaveBeenCalled();
  });
});

describe('Database (SQLite mode)', () => {
  let database;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.DATABASE_URL;
    process.env.DB_PATH = path.join(os.tmpdir(), 'loggplattform-test', 'logs.db');

    database = require('../database');
    await database.initDatabase();
  });

  afterEach(() => {
    delete process.env.DB_PATH;
  });

  test('initDatabase creates tables and indexes', () => {
    expect(mockSqliteDb.serialize).toHaveBeenCalled();
    expect(mockSqliteDb.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS services'),
      expect.any(Function)
    );
    expect(mockSqliteDb.run).toHaveBeenCalledWith(
      expect.stringContaining('idx_logs_correlation_id')
    );
  });

  test('getDatabaseType returns sqlite', () => {
    expect(database.getDatabaseType()).toBe('sqlite');
  });

  test('getPool throws when using SQLite', () => {
    expect(() => database.getPool()).toThrow(/SQLite/);
  });

  test('run delegates to the sqlite driver', (done) => {
    const db = database.getDatabase();

    db.run('DELETE FROM logs WHERE id = ?', ['x'], function (err) {
      expect(err).toBeNull();
      expect(this.changes).toBe(1);
      expect(mockSqliteDb.run).toHaveBeenCalledWith(
        'DELETE FROM logs WHERE id = ?',
        ['x'],
        expect.any(Function)
      );
      done();
    });
  });

  test('get delegates to the sqlite driver', (done) => {
    const db = database.getDatabase();

    db.get('SELECT * FROM logs WHERE id = ?', ['x'], (err, row) => {
      expect(err).toBeNull();
      expect(row).toEqual({ value: 1 });
      done();
    });
  });

  test('all delegates to the sqlite driver', (done) => {
    const db = database.getDatabase();

    db.all('SELECT * FROM logs', [], (err, rows) => {
      expect(err).toBeNull();
      expect(rows).toEqual([{ value: 1 }]);
      done();
    });
  });

  test('serialize delegates to the sqlite driver', () => {
    const db = database.getDatabase();
    const fn = jest.fn();
    db.serialize(fn);
    expect(mockSqliteDb.serialize).toHaveBeenCalledWith(fn);
    expect(fn).toHaveBeenCalled();
  });

  test('prepare wraps the sqlite statement', (done) => {
    const db = database.getDatabase();
    const stmt = db.prepare('INSERT INTO logs (id) VALUES (?)');

    stmt.run(['id-1'], function (err) {
      expect(err).toBeNull();
      expect(this.changes).toBe(1);
      stmt.finalize((finalizeErr) => {
        expect(finalizeErr).toBeNull();
        expect(mockSqliteStmt.finalize).toHaveBeenCalled();
        done();
      });
    });
  });

  test('transaction helpers run BEGIN, COMMIT and ROLLBACK', async () => {
    const db = database.getDatabase();

    await db.beginTransaction();
    expect(mockSqliteDb.run).toHaveBeenCalledWith('BEGIN TRANSACTION', expect.any(Function));

    await db.commitTransaction();
    expect(mockSqliteDb.run).toHaveBeenCalledWith('COMMIT', expect.any(Function));

    await db.beginTransaction();
    await db.rollbackTransaction();
    expect(mockSqliteDb.run).toHaveBeenCalledWith('ROLLBACK', expect.any(Function));
  });

  test('closeDatabase closes the sqlite handle', async () => {
    await database.closeDatabase();
    expect(mockSqliteDb.close).toHaveBeenCalled();
  });
});
