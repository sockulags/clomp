jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() }))
}));

const mockCreateCheckpoint = jest.fn();
jest.mock('../../services/checkpoints', () => ({
  createCheckpoint: (...args) => mockCreateCheckpoint(...args)
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const cron = require('node-cron');
const { startScheduler, stopScheduler, runCheckpointJob } = require('../../services/scheduler');

describe('scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cron.schedule.mockReturnValue({ stop: jest.fn() });
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

  test('the scheduled callback swallows job errors', async () => {
    startScheduler();
    mockPoolQuery.mockRejectedValue(new Error('db down'));
    const callback = cron.schedule.mock.calls[0][1];
    await expect(callback()).resolves.toBeUndefined();
    stopScheduler();
  });
});
