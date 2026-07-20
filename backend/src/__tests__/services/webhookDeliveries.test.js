jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const {
  deliver, sweepPending, pruneOld, startDeliveryWorker, stopDeliveryWorker, backoffDelayMs
} = require('../../services/webhookDeliveries');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

const DELIVERY_ARGS = {
  tenantId: TENANT,
  kind: 'event',
  url: 'https://hooks.example.com/clomp',
  summary: { event_id: 'e1', sequence: 7, action: 'incident.opened' },
  payload: { type: 'event', sequence: 7, action: 'incident.opened' }
};

const ENV_KEYS = [
  'EVENT_WEBHOOK_URL', 'EVENT_WEBHOOK_TOKEN', 'ANCHOR_WEBHOOK_URL', 'ANCHOR_WEBHOOK_TOKEN',
  'WEBHOOK_RETRY_MAX_ATTEMPTS', 'WEBHOOK_RETRY_BASE_MS', 'WEBHOOK_SWEEP_INTERVAL_MS',
  'WEBHOOK_DELIVERY_RETENTION_DAYS'
];

/** The UPDATE call that records an attempt outcome, as [sql, params]. */
function lastUpdateCall() {
  return mockPoolQuery.mock.calls.findLast(([sql]) => sql.includes('UPDATE webhook_deliveries'));
}

describe('webhook deliveries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    global.fetch = jest.fn();
  });

  afterEach(() => {
    stopDeliveryWorker();
    jest.useRealTimers();
  });

  describe('deliver', () => {
    test('records the delivery, POSTs the payload and marks it delivered', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: '11' }] })  // INSERT … RETURNING id
        .mockResolvedValueOnce({ rowCount: 1 });          // UPDATE → delivered
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      expect(await deliver(DELIVERY_ARGS)).toBe('delivered');

      const [insertSql, insertParams] = mockPoolQuery.mock.calls[0];
      expect(insertSql).toContain('INSERT INTO webhook_deliveries');
      // Inserted one claim window ahead so the sweeper cannot race the
      // in-flight first attempt.
      expect(insertSql).toContain('make_interval');
      expect(insertParams[0]).toBe(TENANT);
      expect(insertParams[1]).toBe('event');
      // Only the summary is stored, never the full payload.
      expect(JSON.parse(insertParams[3])).toEqual(DELIVERY_ARGS.summary);

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe(DELIVERY_ARGS.url);
      expect(JSON.parse(opts.body)).toEqual(DELIVERY_ARGS.payload);

      const [updateSql] = lastUpdateCall();
      expect(updateSql).toContain(`'delivered'`);
    });

    test('reads the bearer token from the environment, not from the row', async () => {
      process.env.EVENT_WEBHOOK_TOKEN = 'hook-secret';
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: '11' }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      await deliver(DELIVERY_ARGS);
      expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer hook-secret');
      // The token never appears in what was written to the database.
      for (const [, params] of mockPoolQuery.mock.calls) {
        expect(JSON.stringify(params || [])).not.toContain('hook-secret');
      }
    });

    test('a failed first attempt stays pending with a backoff schedule', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: '11' }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockResolvedValue({ ok: false, status: 502 });

      const before = Date.now();
      expect(await deliver(DELIVERY_ARGS)).toBe('pending');

      const [, params] = lastUpdateCall();
      const [, status, attempts, lastError, nextAttemptAt] = params;
      expect(status).toBe('pending');
      expect(attempts).toBe(1);
      expect(lastError).toContain('502');
      // First retry after the base delay (default 60s).
      const delay = nextAttemptAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(60_000 - 50);
      expect(delay).toBeLessThan(120_000);
    });

    test('network errors are recorded the same way', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: '11' }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await deliver(DELIVERY_ARGS)).toBe('pending');
      expect(lastUpdateCall()[1][3]).toContain('ECONNREFUSED');
    });
  });

  describe('backoff', () => {
    test('doubles per attempt from the configured base', () => {
      process.env.WEBHOOK_RETRY_BASE_MS = '1000';
      expect(backoffDelayMs(1)).toBe(1000);
      expect(backoffDelayMs(2)).toBe(2000);
      expect(backoffDelayMs(3)).toBe(4000);
      expect(backoffDelayMs(4)).toBe(8000);
    });

    test('defaults sum to roughly 15 minutes across 5 attempts', () => {
      // 1m + 2m + 4m + 8m between the 5 attempts.
      expect(backoffDelayMs(1) + backoffDelayMs(2) + backoffDelayMs(3) + backoffDelayMs(4))
        .toBe(15 * 60 * 1000);
    });

    test('attempt budget is clamped to at least one attempt', async () => {
      process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '0';
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: '11' }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockResolvedValue({ ok: false, status: 500 });

      // 0 clamps to 1: the single attempt exhausts the budget immediately.
      expect(await deliver(DELIVERY_ARGS)).toBe('failed');
      expect(lastUpdateCall()[1][1]).toBe('failed');
    });
  });

  describe('sweepPending', () => {
    const pendingEventRow = (extra = {}) => ({
      id: '11', tenant_id: TENANT, kind: 'event',
      url: 'https://hooks.example.com/clomp',
      payload_summary: { event_id: 'e1', sequence: 7, action: 'incident.opened' },
      status: 'pending', attempt_count: 1, ...extra
    });

    const eventSourceRow = {
      id: 'e1', tenant_id: TENANT, sequence: '7',
      occurred_at: new Date('2026-07-14T10:00:00Z'), recorded_at: new Date('2026-07-14T10:00:01Z'),
      actor: { type: 'user', id: 'ops' }, action: 'incident.opened',
      target: null, context: null, evidence: null,
      prev_hash: 'aa'.repeat(32), hash: 'ab'.repeat(32)
    };

    test('claims due rows atomically, rebuilds the event payload and retries', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [pendingEventRow()] })   // claim due rows
        .mockResolvedValueOnce({ rows: [eventSourceRow] })      // SELECT events
        .mockResolvedValueOnce({ rowCount: 1 });                // UPDATE → delivered
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      expect(await sweepPending()).toBe(1);

      // The pick is an atomic claim: due rows are locked (SKIP LOCKED) and
      // pushed a claim window ahead before any POST, so a concurrent sweep
      // cannot double-deliver.
      const [claimSql] = mockPoolQuery.mock.calls[0];
      expect(claimSql).toContain('UPDATE webhook_deliveries');
      expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
      expect(claimSql).toContain('RETURNING *');

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.type).toBe('event');
      expect(body.sequence).toBe(7);
      expect(body.hash).toBe('ab'.repeat(32));
      expect(lastUpdateCall()[0]).toContain(`'delivered'`);
    });

    test('rebuilds anchor payloads from the checkpoints table with the anchor token', async () => {
      process.env.ANCHOR_WEBHOOK_TOKEN = 'anchor-secret';
      const pendingAnchor = pendingEventRow({
        kind: 'anchor',
        payload_summary: { checkpoint_id: 'cp1', sequence: 42, hash: 'cd'.repeat(32) }
      });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [pendingAnchor] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'cp1', tenant_id: TENANT, sequence: '42', hash: 'cd'.repeat(32),
            signature: 'c2ln', public_key: '-----BEGIN PUBLIC KEY-----',
            signed_at: new Date('2026-07-14T02:00:00Z')
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      await sweepPending();

      expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer anchor-secret');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.type).toBe('checkpoint');
      expect(body.sequence).toBe(42);
      expect(body.signature).toBe('c2ln');
      expect(body.signed_at).toBe('2026-07-14T02:00:00.000Z');
      // Key order matches the first-attempt body from anchoring.js.
      expect(Object.keys(body)).toEqual(
        ['type', 'id', 'tenant_id', 'sequence', 'hash', 'signed_at', 'signature', 'public_key']
      );
    });

    test('a transient DB error during rebuild does not consume the attempt budget', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [pendingEventRow()] })
        .mockRejectedValueOnce(new Error('db blip'));  // SELECT events fails

      expect(await sweepPending()).toBe(1);

      expect(global.fetch).not.toHaveBeenCalled();
      // No status/attempt update — the claim window is the natural backoff,
      // so only the claim and the failed source lookup hit the pool.
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    test('marks the delivery failed after exhausting the attempt budget', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [pendingEventRow({ attempt_count: 4 })] }) // 5th attempt (max 5)
        .mockResolvedValueOnce({ rows: [eventSourceRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      global.fetch.mockResolvedValue({ ok: false, status: 500 });

      await sweepPending();

      const [, params] = lastUpdateCall();
      expect(params[1]).toBe('failed');
      expect(params[2]).toBe(5);
      expect(params[4]).toBeNull(); // no further attempt scheduled
    });

    test('fails permanently when the source event no longer exists', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [pendingEventRow()] })
        .mockResolvedValueOnce({ rows: [] })  // event pruned by retention
        .mockResolvedValueOnce({ rowCount: 1 });

      await sweepPending();

      expect(global.fetch).not.toHaveBeenCalled();
      const [, params] = lastUpdateCall();
      expect(params[1]).toBe('failed');
      expect(params[2]).toBe(2); // real attempt count, not a synthetic budget value
      expect(params[3]).toContain('source row no longer exists');
    });

    test('does nothing when no deliveries are due', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      expect(await sweepPending()).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('worker', () => {
    test('does not start when no webhook is configured', () => {
      jest.useFakeTimers();
      expect(startDeliveryWorker()).toBe(false);
      jest.advanceTimersByTime(120_000);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('sweeps on the configured interval when a webhook is configured', async () => {
      jest.useFakeTimers();
      process.env.EVENT_WEBHOOK_URL = 'https://hooks.example.com/clomp';
      process.env.WEBHOOK_SWEEP_INTERVAL_MS = '5000';
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      expect(startDeliveryWorker()).toBe(true);
      expect(startDeliveryWorker()).toBe(false); // idempotent

      await jest.advanceTimersByTimeAsync(5000);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining(`status = 'pending' AND next_attempt_at <= now()`),
        expect.anything()
      );
    });

    test('a sweep failure does not kill the interval', async () => {
      jest.useFakeTimers();
      process.env.ANCHOR_WEBHOOK_URL = 'https://anchors.example/clomp';
      process.env.WEBHOOK_SWEEP_INTERVAL_MS = '5000';
      mockPoolQuery.mockRejectedValueOnce(new Error('db down'));

      startDeliveryWorker();
      await jest.advanceTimersByTimeAsync(5000);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockPoolQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pruneOld', () => {
    test('deletes finished rows past the retention window', async () => {
      process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '7';
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 3 });

      expect(await pruneOld()).toBe(3);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain(`status IN ('delivered', 'failed')`);
      expect(params).toEqual([7]);
    });
  });
});
