jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() }))
}));

const mockCreateCheckpoint = jest.fn();
jest.mock('../../services/checkpoints', () => ({
  createCheckpoint: (...args) => mockCreateCheckpoint(...args)
}));

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockClientRelease };
const mockConnect = jest.fn(async () => mockClient);
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockConnect })
}));

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockIsConfigured = jest.fn(() => false);
const mockAnchorCheckpoint = jest.fn();
jest.mock('../../services/anchoring', () => ({
  isConfigured: (...args) => mockIsConfigured(...args),
  anchorCheckpoint: (...args) => mockAnchorCheckpoint(...args)
}));

const mockNotifyIsConfigured = jest.fn(() => false);
const mockRunOverdueNotificationJob = jest.fn();
jest.mock('../../services/notifications', () => ({
  isConfigured: (...args) => mockNotifyIsConfigured(...args),
  runOverdueNotificationJob: (...args) => mockRunOverdueNotificationJob(...args)
}));

const cron = require('node-cron');
const { startScheduler, stopScheduler, runCheckpointJob, runExclusively } = require('../../services/scheduler');

describe('scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cron.schedule.mockReturnValue({ stop: jest.fn() });
    // Default: the advisory lock is granted; unlock succeeds.
    mockClientQuery.mockResolvedValue({ rows: [{ locked: true }] });
  });

  test('schedules the nightly checkpoint job at 02:00 UTC by default', () => {
    startScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule.mock.calls[0][0]).toBe('0 2 * * *');
    expect(cron.schedule.mock.calls[0][2]).toEqual(expect.objectContaining({ timezone: 'UTC' }));
    stopScheduler();
  });

  test('runCheckpointJob signs a checkpoint per tenant with events', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }] });
    mockCreateCheckpoint
      .mockResolvedValueOnce({ sequence: 5 })
      .mockResolvedValueOnce(null); // tenant with no events yields no checkpoint

    const created = await runCheckpointJob();
    expect(created).toBe(1);
    expect(mockCreateCheckpoint).toHaveBeenCalledWith('t1');
    expect(mockCreateCheckpoint).toHaveBeenCalledWith('t2');
  });

  test('anchors each created checkpoint when anchoring is configured', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockAnchorCheckpoint.mockResolvedValue({ webhook: 'ok', email: 'skipped' });
    mockPoolQuery.mockResolvedValue({ rows: [{ tenant_id: 't1' }] });
    mockCreateCheckpoint.mockResolvedValueOnce({ sequence: 5 });

    await runCheckpointJob();
    expect(mockAnchorCheckpoint).toHaveBeenCalledWith({ sequence: 5 });
    mockIsConfigured.mockReturnValue(false);
  });

  test('does not anchor when anchoring is unconfigured', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ tenant_id: 't1' }] });
    mockCreateCheckpoint.mockResolvedValueOnce({ sequence: 5 });

    await runCheckpointJob();
    expect(mockAnchorCheckpoint).not.toHaveBeenCalled();
  });

  test('the scheduled callback swallows job errors', async () => {
    startScheduler();
    mockPoolQuery.mockRejectedValue(new Error('db down'));
    const callback = cron.schedule.mock.calls[0][1];
    await expect(callback()).resolves.toBeUndefined();
    stopScheduler();
  });

  describe('runExclusively (multi-instance advisory lock)', () => {
    test('runs the job when the advisory lock is acquired, then releases lock and client', async () => {
      const job = jest.fn().mockResolvedValue(42);

      const outcome = await runExclusively('checkpoint', job);

      expect(outcome).toEqual({ ran: true, result: 42 });
      expect(job).toHaveBeenCalledTimes(1);

      // Lock and unlock happen on the same dedicated client, in namespaced form.
      expect(mockClientQuery).toHaveBeenCalledTimes(2);
      expect(mockClientQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock(hashtext($1), hashtext($2))');
      expect(mockClientQuery.mock.calls[0][1]).toEqual(['clomp:jobs', 'checkpoint']);
      expect(mockClientQuery.mock.calls[1][0]).toContain('pg_advisory_unlock(hashtext($1), hashtext($2))');
      expect(mockClientQuery.mock.calls[1][1]).toEqual(['clomp:jobs', 'checkpoint']);
      expect(mockClientRelease).toHaveBeenCalledWith();
    });

    test('skips the job when another instance holds the lock', async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [{ locked: false }] });
      const job = jest.fn();

      const outcome = await runExclusively('checkpoint', job);

      expect(outcome).toEqual({ ran: false, result: null });
      expect(job).not.toHaveBeenCalled();
      // No unlock for a lock we never held; the client still goes back to the pool.
      expect(mockClientQuery).toHaveBeenCalledTimes(1);
      expect(mockClientRelease).toHaveBeenCalledWith();
    });

    test('releases the lock even when the job throws', async () => {
      const job = jest.fn().mockRejectedValue(new Error('job blew up'));

      await expect(runExclusively('checkpoint', job)).rejects.toThrow('job blew up');

      expect(mockClientQuery).toHaveBeenCalledTimes(2);
      expect(mockClientQuery.mock.calls[1][0]).toContain('pg_advisory_unlock');
      expect(mockClientRelease).toHaveBeenCalledWith();
    });

    test('destroys the connection when the unlock itself fails', async () => {
      const unlockError = new Error('connection lost');
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockRejectedValueOnce(unlockError);
      const job = jest.fn().mockResolvedValue('ok');

      const outcome = await runExclusively('checkpoint', job);

      expect(outcome).toEqual({ ran: true, result: 'ok' });
      // release(err) evicts the connection so the stuck session lock dies with it.
      expect(mockClientRelease).toHaveBeenCalledWith(unlockError);
    });

    test('uses a distinct lock key per job', async () => {
      await runExclusively('checkpoint', jest.fn());
      await runExclusively('overdue-notify', jest.fn());

      const lockCalls = mockClientQuery.mock.calls.filter(c => c[0].includes('pg_try_advisory_lock'));
      expect(lockCalls.map(c => c[1])).toEqual([
        ['clomp:jobs', 'checkpoint'],
        ['clomp:jobs', 'overdue-notify']
      ]);
    });
  });

  describe('scheduled callbacks take the job lock', () => {
    test('checkpoint callback runs the job under the lock and skips when denied', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      startScheduler();
      const callback = cron.schedule.mock.calls[0][1];

      await callback();
      expect(mockClientQuery.mock.calls[0][1]).toEqual(['clomp:jobs', 'checkpoint']);
      expect(mockPoolQuery).toHaveBeenCalled(); // job body ran

      jest.clearAllMocks();
      mockClientQuery.mockResolvedValue({ rows: [{ locked: false }] });
      await callback();
      expect(mockPoolQuery).not.toHaveBeenCalled(); // lock denied: job body skipped
      stopScheduler();
    });

    test('notification callback runs the notification job under its own lock', async () => {
      mockNotifyIsConfigured.mockReturnValue(true);
      mockRunOverdueNotificationJob.mockResolvedValue(1);
      startScheduler();
      expect(cron.schedule).toHaveBeenCalledTimes(2);
      const callback = cron.schedule.mock.calls[1][1];

      await callback();
      expect(mockClientQuery.mock.calls[0][1]).toEqual(['clomp:jobs', 'overdue-notify']);
      expect(mockRunOverdueNotificationJob).toHaveBeenCalledTimes(1);

      mockNotifyIsConfigured.mockReturnValue(false);
      stopScheduler();
    });
  });
});
