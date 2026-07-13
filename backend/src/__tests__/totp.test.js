const { totp, verifyTotp, generateSecret, otpauthUrl, base32Encode, base32Decode } = require('../totp');

// RFC 6238 Appendix B test vectors (SHA-1, truncated to 6 digits).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  test('matches RFC 6238 test vectors', () => {
    expect(totp(RFC_SECRET, 59 * 1000)).toBe('287082');
    expect(totp(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
    expect(totp(RFC_SECRET, 2000000000 * 1000)).toBe('279037');
  });

  test('verifyTotp accepts current step and ±1 drift', () => {
    const now = 1111111109 * 1000;
    expect(verifyTotp(RFC_SECRET, '081804', now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 90_000), now)).toBe(false);
  });

  test('verifyTotp rejects malformed tokens', () => {
    expect(verifyTotp(RFC_SECRET, 'abc123')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '')).toBe(false);
  });

  test('base32 round-trips', () => {
    const buf = Buffer.from('clomp-secret-material');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  test('generateSecret returns valid base32 that verifies against itself', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const code = totp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  test('otpauthUrl embeds issuer and account', () => {
    const url = otpauthUrl('ABC234', 'user@example.com');
    expect(url).toContain('otpauth://totp/clomp%3Auser%40example.com');
    expect(url).toContain('secret=ABC234');
  });
});
