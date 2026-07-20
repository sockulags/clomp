jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail }))
}), { virtual: false });

const mockDeliver = jest.fn();
jest.mock('../../services/webhookDeliveries', () => ({
  deliver: (...args) => mockDeliver(...args)
}));

const { isConfigured, anchorCheckpoint, checkpointDigest } = require('../../services/anchoring');

const CHECKPOINT = {
  id: 'cccccccc-0000-0000-0000-000000000001',
  tenant_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  sequence: 42,
  hash: 'ab'.repeat(32),
  signature: 'c2lnbmF0dXJl',
  public_key: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n',
  signed_at: '2026-07-14T02:00:00.000Z'
};

const ENV_KEYS = [
  'ANCHOR_WEBHOOK_URL', 'ANCHOR_WEBHOOK_TOKEN',
  'ANCHOR_EMAIL_TO', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'
];

describe('anchoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    mockDeliver.mockResolvedValue('delivered');
  });

  test('is not configured by default', () => {
    expect(isConfigured()).toBe(false);
  });

  test('anchorCheckpoint skips everything when unconfigured', async () => {
    const result = await anchorCheckpoint(CHECKPOINT);
    expect(result).toEqual({ webhook: 'skipped', email: 'skipped' });
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  describe('webhook', () => {
    beforeEach(() => {
      process.env.ANCHOR_WEBHOOK_URL = 'https://anchors.example/clomp';
    });

    test('hands the checkpoint to the durable delivery layer', async () => {
      const result = await anchorCheckpoint(CHECKPOINT);
      expect(result.webhook).toBe('ok');

      expect(mockDeliver).toHaveBeenCalledWith({
        tenantId: CHECKPOINT.tenant_id,
        kind: 'anchor',
        url: 'https://anchors.example/clomp',
        summary: { checkpoint_id: CHECKPOINT.id, sequence: 42, hash: CHECKPOINT.hash },
        payload: expect.objectContaining({ type: 'checkpoint', sequence: 42, signature: CHECKPOINT.signature })
      });
      // The summary never carries the signature or public key.
      expect(mockDeliver.mock.calls[0][0].summary.signature).toBeUndefined();
    });

    test('reports failure when delivery is left pending for retry', async () => {
      mockDeliver.mockResolvedValue('pending');
      const result = await anchorCheckpoint(CHECKPOINT);
      expect(result.webhook).toBe('failed');
    });

    test('reports failure without throwing when recording the delivery fails', async () => {
      mockDeliver.mockRejectedValue(new Error('insert failed'));
      const result = await anchorCheckpoint(CHECKPOINT);
      expect(result.webhook).toBe('failed');
    });
  });

  describe('email', () => {
    beforeEach(() => {
      process.env.ANCHOR_EMAIL_TO = 'auditor@example.com';
      process.env.SMTP_HOST = 'smtp.example.com';
    });

    test('sends the digest to the configured recipient', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'm1' });

      const result = await anchorCheckpoint(CHECKPOINT);
      expect(result.email).toBe('ok');

      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.to).toBe('auditor@example.com');
      expect(mail.subject).toContain('sequence 42');
      expect(mail.text).toContain(CHECKPOINT.hash);
      expect(mail.text).toContain(CHECKPOINT.signature);
      expect(mail.text).toContain('BEGIN PUBLIC KEY');
    });

    test('reports failure without throwing when SMTP fails', async () => {
      mockSendMail.mockRejectedValue(new Error('SMTP down'));
      const result = await anchorCheckpoint(CHECKPOINT);
      expect(result.email).toBe('failed');
    });
  });

  test('digest contains everything needed to verify against an export', () => {
    const digest = checkpointDigest(CHECKPOINT);
    for (const needle of [CHECKPOINT.tenant_id, '42', CHECKPOINT.hash, CHECKPOINT.signature, CHECKPOINT.signed_at]) {
      expect(digest).toContain(String(needle));
    }
  });
});
