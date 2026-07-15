jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
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
    global.fetch = jest.fn();
  });

  test('off by default', async () => {
    expect(isConfigured()).toBe(false);
    expect(await dispatchEvent(EVENT)).toBe('skipped');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('configured', () => {
    beforeEach(() => {
      process.env.EVENT_WEBHOOK_URL = 'https://hooks.example.com/clomp';
    });

    test('POSTs the event as JSON', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      expect(await dispatchEvent(EVENT)).toBe('ok');

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/clomp');
      const body = JSON.parse(opts.body);
      expect(body.type).toBe('event');
      expect(body.sequence).toBe(7);
      expect(body.action).toBe('incident.opened');
    });

    test('sends a bearer token when configured', async () => {
      process.env.EVENT_WEBHOOK_TOKEN = 'hook-secret';
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      await dispatchEvent(EVENT);
      expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer hook-secret');
    });

    test('action prefix filter includes and excludes', async () => {
      process.env.EVENT_WEBHOOK_ACTIONS = 'incident., retention.';
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      expect(await dispatchEvent(EVENT)).toBe('ok');
      expect(await dispatchEvent({ ...EVENT, action: 'patch.applied' })).toBe('skipped');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('failures are reported, never thrown', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500 });
      expect(await dispatchEvent(EVENT)).toBe('failed');

      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await dispatchEvent(EVENT)).toBe('failed');
    });
  });
});
