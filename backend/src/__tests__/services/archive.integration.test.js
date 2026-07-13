// End-to-end coverage for the archive service.
//
// The sibling archive.test.js mocks out ../../database and only exercises the
// pure getArchiveFilePath helper. This suite drives the real archiving/retention
// logic (archiveOldLogs, readArchivedLogs, cleanupOldArchives) against a temp
// ARCHIVE_DIR, with the database layer replaced by an in-memory store that
// answers the exact queries archive.js issues. No live PostgreSQL is needed:
// the SQL surface is three fixed statements (SELECT DISTINCT services, SELECT
// logs per service, DELETE by id batch).

const os = require('os');
const path = require('path');
const fs = require('fs');

// In-memory database state, reset per test.
let store = null;

function makeStore() {
  return {
    services: [], // names
    logs: [] // full rows as stored
  };
}

// Adapter mock: answers the two SELECTs archiveOldLogs runs via db.all.
const mockAdapter = {
  all: (sql, params, callback) => {
    try {
      if (sql.includes('DISTINCT name FROM services')) {
        callback(null, store.services.map(name => ({ name })));
        return;
      }
      if (sql.includes('FROM logs')) {
        const [service, cutoff, limit] = params;
        const rows = store.logs
          .filter(l => l.service === service && l.timestamp < cutoff)
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
          .slice(0, limit);
        callback(null, rows);
        return;
      }
      callback(new Error(`Unexpected SQL in fake adapter: ${sql}`));
    } catch (err) {
      callback(err);
    }
  }
};

// Pool mock: handles BEGIN/COMMIT/ROLLBACK and the batched DELETE in deleteLogs.
const mockClient = {
  query: jest.fn((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.startsWith('DELETE FROM logs WHERE id IN')) {
      const before = store.logs.length;
      const ids = new Set(params);
      store.logs = store.logs.filter(l => !ids.has(l.id));
      return Promise.resolve({ rows: [], rowCount: before - store.logs.length });
    }
    return Promise.reject(new Error(`Unexpected SQL in fake client: ${sql}`));
  }),
  release: jest.fn()
};

const mockPool = {
  connect: jest.fn(() => Promise.resolve(mockClient))
};

jest.mock('../../database', () => ({
  getDatabase: () => mockAdapter,
  getPool: () => mockPool
}));

jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn()
}));

function insertService(name) {
  store.services.push(name);
}

function insertLog(log) {
  store.logs.push({ ...log });
}

// Mirrors the date-bucket loop inside readArchivedLogs so the test writes archive
// files to exactly the paths the code will scan for a given range. This keeps the
// suite timezone-independent.
function scannedArchivePaths(getArchiveFilePath, service, startTime, endTime) {
  const startDate = startTime ? new Date(startTime) : new Date(0);
  const endDate = endTime ? new Date(endTime) : new Date();
  const paths = [];
  const currentDate = new Date(startDate);
  currentDate.setHours(0, 0, 0, 0);
  while (currentDate <= endDate) {
    paths.push(getArchiveFilePath(new Date(currentDate), service));
    currentDate.setDate(currentDate.getDate() + 1);
  }
  return paths;
}

function writeArchiveFile(filePath, logs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = logs.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

describe('Archive service (end-to-end)', () => {
  let tmpRoot;
  let archiveDir;
  let archive;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-e2e-'));
    archiveDir = path.join(tmpRoot, 'archives');
    process.env.ARCHIVE_DIR = archiveDir;
    process.env.ARCHIVE_RETENTION_DAYS = '30';

    store = makeStore();

    archive = require('../../services/archive');
  });

  afterEach(() => {
    store = null;
    delete process.env.ARCHIVE_DIR;
    delete process.env.ARCHIVE_RETENTION_DAYS;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Windows can transiently hold files; best-effort cleanup.
    }
  });

  describe('archiveOldLogs', () => {
    test('writes JSONL buckets and removes archived rows from the DB', async () => {
      insertService('api');
      insertService('web');

      // Two old logs on 2020-01-01 (same bucket) + one on 2020-01-02 for "api".
      insertLog({
        id: 'l1',
        timestamp: '2020-01-01T10:00:00.000Z',
        level: 'info',
        service: 'api',
        message: 'first',
        context: JSON.stringify({ a: 1 }),
        correlation_id: 'c1',
        created_at: '2020-01-01T10:00:00.000Z'
      });
      insertLog({
        id: 'l2',
        timestamp: '2020-01-01T12:00:00.000Z',
        level: 'error',
        service: 'api',
        message: 'second',
        context: null,
        correlation_id: 'c2',
        created_at: '2020-01-01T12:00:00.000Z'
      });
      insertLog({
        id: 'l3',
        timestamp: '2020-01-02T09:00:00.000Z',
        level: 'warn',
        service: 'api',
        message: 'third',
        context: JSON.stringify({ b: 2 }),
        correlation_id: null,
        created_at: '2020-01-02T09:00:00.000Z'
      });
      // One old log for a second service to exercise the services loop.
      insertLog({
        id: 'l5',
        timestamp: '2020-01-01T08:00:00.000Z',
        level: 'info',
        service: 'web',
        message: 'web-old',
        context: null,
        correlation_id: null,
        created_at: '2020-01-01T08:00:00.000Z'
      });
      // A recent log that must NOT be archived (newer than the cutoff).
      insertLog({
        id: 'l4',
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'api',
        message: 'recent',
        context: null,
        correlation_id: null,
        created_at: new Date().toISOString()
      });

      const total = await archive.archiveOldLogs(1);

      expect(total).toBe(4);

      // api / 2020-01-01 bucket: two lines, ordered by timestamp ascending.
      const apiJan1Lines = fs
        .readFileSync(path.join(archiveDir, '2020-01-01', 'api.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      expect(apiJan1Lines).toHaveLength(2);
      expect(apiJan1Lines[0]).toEqual({
        id: 'l1',
        timestamp: '2020-01-01T10:00:00.000Z',
        level: 'info',
        service: 'api',
        message: 'first',
        context: { a: 1 }, // stored JSON string is re-parsed into an object
        correlation_id: 'c1',
        created_at: '2020-01-01T10:00:00.000Z'
      });
      expect(apiJan1Lines[1].id).toBe('l2');
      expect(apiJan1Lines[1].context).toBeNull();

      // api / 2020-01-02 bucket: single line.
      const apiJan2Lines = fs
        .readFileSync(path.join(archiveDir, '2020-01-02', 'api.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      expect(apiJan2Lines).toHaveLength(1);
      expect(apiJan2Lines[0].id).toBe('l3');
      expect(apiJan2Lines[0].context).toEqual({ b: 2 });

      // web / 2020-01-01 bucket: single line.
      const webJan1Lines = fs
        .readFileSync(path.join(archiveDir, '2020-01-01', 'web.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      expect(webJan1Lines).toHaveLength(1);
      expect(webJan1Lines[0].id).toBe('l5');

      // deleteLogs ran inside a transaction: only the recent log remains.
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      expect(store.logs.map(l => l.id)).toEqual(['l4']);
    });

    test('returns 0 and writes nothing when there is nothing old to archive', async () => {
      insertService('api');
      insertLog({
        id: 'recent-only',
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'api',
        message: 'recent',
        context: null,
        correlation_id: null,
        created_at: new Date().toISOString()
      });

      const total = await archive.archiveOldLogs(1);

      expect(total).toBe(0);
      expect(store.logs).toHaveLength(1);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });
  });

  describe('readArchivedLogs', () => {
    const service = 'svc';
    const start = '2021-03-10T00:00:00.000Z';
    const end = '2021-03-12T23:59:59.999Z';

    function baseLogs() {
      return [
        {
          id: 'r1',
          timestamp: '2021-03-10T01:00:00.000Z',
          level: 'info',
          service,
          message: 'one',
          context: null,
          correlation_id: 'x'
        },
        {
          id: 'r2',
          timestamp: '2021-03-10T02:00:00.000Z',
          level: 'error',
          service,
          message: 'two',
          context: null,
          correlation_id: 'y'
        },
        {
          id: 'r3',
          timestamp: '2021-03-10T03:00:00.000Z',
          level: 'info',
          service,
          message: 'three',
          context: null,
          correlation_id: 'x'
        }
      ];
    }

    test('returns all matching logs in a range, sorted newest first', async () => {
      const [firstFile] = scannedArchivePaths(archive.getArchiveFilePath, service, start, end);
      writeArchiveFile(firstFile, baseLogs());

      const logs = await archive.readArchivedLogs(service, start, end, {});

      expect(logs.map(l => l.id)).toEqual(['r3', 'r2', 'r1']);
    });

    test('filters by level', async () => {
      const [firstFile] = scannedArchivePaths(archive.getArchiveFilePath, service, start, end);
      writeArchiveFile(firstFile, baseLogs());

      const logs = await archive.readArchivedLogs(service, start, end, { level: 'error' });

      expect(logs.map(l => l.id)).toEqual(['r2']);
    });

    test('filters by correlationId', async () => {
      const [firstFile] = scannedArchivePaths(archive.getArchiveFilePath, service, start, end);
      writeArchiveFile(firstFile, baseLogs());

      const logs = await archive.readArchivedLogs(service, start, end, { correlationId: 'x' });

      expect(logs.map(l => l.id).sort()).toEqual(['r1', 'r3']);
    });

    test('filters out logs whose timestamp falls outside the requested window', async () => {
      const narrowStart = '2021-03-10T02:30:00.000Z';
      const [firstFile] = scannedArchivePaths(
        archive.getArchiveFilePath,
        service,
        narrowStart,
        end
      );
      writeArchiveFile(firstFile, baseLogs());

      const logs = await archive.readArchivedLogs(service, narrowStart, end, {});

      // Only r3 (03:00) is at/after the narrowed start; r1 and r2 are excluded.
      expect(logs.map(l => l.id)).toEqual(['r3']);
    });

    test('honours the maxLogs early-exit across multiple archive files', async () => {
      const paths = scannedArchivePaths(archive.getArchiveFilePath, service, start, end);
      // Two logs in the first day's file, two in the second day's file.
      writeArchiveFile(paths[0], [
        {
          id: 'd1a',
          timestamp: '2021-03-10T01:00:00.000Z',
          level: 'info',
          service,
          message: 'a',
          context: null,
          correlation_id: null
        },
        {
          id: 'd1b',
          timestamp: '2021-03-10T02:00:00.000Z',
          level: 'info',
          service,
          message: 'b',
          context: null,
          correlation_id: null
        }
      ]);
      writeArchiveFile(paths[1], [
        {
          id: 'd2a',
          timestamp: '2021-03-11T01:00:00.000Z',
          level: 'info',
          service,
          message: 'c',
          context: null,
          correlation_id: null
        },
        {
          id: 'd2b',
          timestamp: '2021-03-11T02:00:00.000Z',
          level: 'info',
          service,
          message: 'd',
          context: null,
          correlation_id: null
        }
      ]);

      const logs = await archive.readArchivedLogs(service, start, end, {}, 3);

      // Stops once the limit is hit rather than reading all four entries.
      expect(logs).toHaveLength(3);
    });

    test('returns an empty array when no archive files exist for the range', async () => {
      const logs = await archive.readArchivedLogs('missing-service', start, end, {});
      expect(logs).toEqual([]);
    });
  });

  describe('cleanupOldArchives', () => {
    // ARCHIVE_RETENTION_DAYS is 30 (set in beforeEach). Freeze "now" so the
    // retention cutoff is deterministic and lands exactly on a directory date,
    // exercising the strict `dirDate < cutoffDate` boundary.
    const FIXED_NOW = new Date('2025-06-15T00:00:00.000Z'); // cutoff => 2025-05-16T00:00:00Z

    beforeEach(() => {
      jest.useFakeTimers({
        now: FIXED_NOW,
        // Only fake Date; leave timers/microtasks/IO alone so fs works.
        doNotFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'setImmediate',
          'clearImmediate',
          'nextTick',
          'queueMicrotask',
          'hrtime',
          'performance',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback'
        ]
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('deletes dirs strictly older than the retention cutoff, keeps the rest', async () => {
      const mk = name => fs.mkdirSync(path.join(archiveDir, name), { recursive: true });

      // cutoff = 2025-06-15 - 30d = 2025-05-16T00:00:00Z
      const beforeDir = '2025-05-15'; // strictly older     -> deleted
      const atDir = '2025-05-16'; // exactly at cutoff  -> retained (strict <)
      const afterDir = '2025-05-17'; // newer              -> retained
      mk(beforeDir);
      mk(atDir);
      mk(afterDir);
      // A stray non-directory entry should be ignored, not crash.
      fs.writeFileSync(path.join(archiveDir, 'not-a-dir.txt'), 'x');

      const deletedCount = await archive.cleanupOldArchives();

      expect(deletedCount).toBe(1);
      expect(fs.existsSync(path.join(archiveDir, beforeDir))).toBe(false);
      expect(fs.existsSync(path.join(archiveDir, atDir))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir, afterDir))).toBe(true);
    });
  });
});
