jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockDeliver = jest.fn();
jest.mock('../../services/webhookDeliveries', () => ({
  deliver: (...args) => mockDeliver(...args)
}));

const { isConfigured, dispatchEvent } = require('../../services/eventWebhooks');

const EVENT = {
  id: 'e1', tenant_id: 't1', sequence: 7,
  action: 'incident.opened',
  actor: { type: 'user', id: 'ops' },
  hash: 'ab'.repeat(32)
};

describe('event webhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVENT_WEBHOOK_URL;
    delete process.env.EVENT_WEBHOOK_TOKEN;
    delete process.env.EVENT_WEBHOOK_ACTIONS;
    mockDeliver.mockResolvedValue('delivered');
  });

  test('off by default', async () => {
    expect(isConfigured()).toBe(false);
    expect(await dispatchEvent(EVENT)).toBe('skipped');
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  describe('configured', () => {
    beforeEach(() => {
      process.env.EVENT_WEBHOOK_URL = 'https://hooks.example.com/clomp';
    });

    test('hands the event to the durable delivery layer', async () => {
      expect(await dispatchEvent(EVENT)).toBe('ok');

      expect(mockDeliver).toHaveBeenCalledWith({
        tenantId: 't1',
        kind: 'event',
        url: 'https://hooks.example.com/clomp',
        summary: { event_id: 'e1', sequence: 7, action: 'incident.opened' },
        payload: expect.objectContaining({ type: 'event', sequence: 7, action: 'incident.opened' })
      });
      // The summary never carries actor/context — only identifiers.
      expect(mockDeliver.mock.calls[0][0].summary.actor).toBeUndefined();
    });

    test('action prefix filter includes and excludes', async () => {
      process.env.EVENT_WEBHOOK_ACTIONS = 'incident., retention.';

      expect(await dispatchEvent(EVENT)).toBe('ok');
      expect(await dispatchEvent({ ...EVENT, action: 'patch.applied' })).toBe('skipped');
      expect(mockDeliver).toHaveBeenCalledTimes(1);
    });

    test('a first attempt left pending for retry reports failed to the caller', async () => {
      mockDeliver.mockResolvedValue('pending');
      expect(await dispatchEvent(EVENT)).toBe('failed');
    });

    test('failures are reported, never thrown', async () => {
      mockDeliver.mockResolvedValue('failed');
      expect(await dispatchEvent(EVENT)).toBe('failed');

      mockDeliver.mockRejectedValue(new Error('insert failed'));
      expect(await dispatchEvent(EVENT)).toBe('failed');
    });
  });
});
