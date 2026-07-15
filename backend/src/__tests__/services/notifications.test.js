jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail }))
}));

const mockPoolQuery = jest.fn();
jest.mock('../../database', () => ({
  getPool: () => ({ query: mockPoolQuery })
}));

const mockListWithStatus = jest.fn();
jest.mock('../../services/schedules', () => ({
  listWithStatus: (...args) => mockListWithStatus(...args)
}));

const { isConfigured, runOverdueNotificationJob, digestBody } = require('../../services/notifications');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

const schedule = (status, extra = {}) => ({
  action: 'access.review.completed',
  title: 'Quarterly access review',
  frequency: 'quarterly',
  status,
  last_event_at: null,
  next_due_at: '2026-05-05T00:00:00.000Z',
  ...extra
});

const ENV_KEYS = ['NOTIFY_EMAIL_TO', 'NOTIFY_INCLUDE_DUE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'];

describe('overdue notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test('not configured by default; job is a no-op', async () => {
    expect(isConfigured()).toBe(false);
    expect(await runOverdueNotificationJob()).toBe(0);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  describe('configured', () => {
    beforeEach(() => {
      process.env.NOTIFY_EMAIL_TO = 'ciso@example.com';
      process.env.SMTP_HOST = 'smtp.example.com';
      mockPoolQuery.mockResolvedValue({ rows: [{ tenant_id: TENANT }] });
    });

    test('sends a digest when a control is overdue', async () => {
      mockListWithStatus.mockResolvedValue([schedule('overdue'), schedule('ok', { action: 'backup.tested' })]);
      mockSendMail.mockResolvedValue({});

      expect(await runOverdueNotificationJob()).toBe(1);
      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.to).toBe('ciso@example.com');
      expect(mail.subject).toContain('1 scheduled control(s) overdue');
      expect(mail.text).toContain('OVERDUE');
      expect(mail.text).toContain('Quarterly access review');
      expect(mail.text).not.toContain('backup.tested'); // on-time controls stay out
    });

    test('stays silent when everything is on time', async () => {
      mockListWithStatus.mockResolvedValue([schedule('ok'), schedule('ok', { action: 'backup.tested' })]);
      expect(await runOverdueNotificationJob()).toBe(0);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('due controls are excluded unless NOTIFY_INCLUDE_DUE=true', async () => {
      mockListWithStatus.mockResolvedValue([schedule('due')]);
      expect(await runOverdueNotificationJob()).toBe(0);

      process.env.NOTIFY_INCLUDE_DUE = 'true';
      expect(await runOverdueNotificationJob()).toBe(1);
      expect(mockSendMail.mock.calls[0][0].text).toContain('DUE');
    });

    test('an SMTP failure is logged, not thrown', async () => {
      mockListWithStatus.mockResolvedValue([schedule('overdue')]);
      mockSendMail.mockRejectedValue(new Error('SMTP down'));
      expect(await runOverdueNotificationJob()).toBe(0);
    });
  });

  test('digest body lists action, cadence and due date', () => {
    const body = digestBody([schedule('overdue')]);
    expect(body).toContain('access.review.completed');
    expect(body).toContain('quarterly');
    expect(body).toContain('2026-05-05');
    expect(body).toContain('never');
  });
});
