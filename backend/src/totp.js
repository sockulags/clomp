/**
 * Minimal RFC 6238 TOTP (SHA-1, 6 digits, 30s steps) — no dependency needed.
 */
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

function totp(secretBase32, timestampMs = Date.now(), stepSeconds = 30) {
  return hotp(secretBase32, Math.floor(timestampMs / 1000 / stepSeconds));
}

/** Accepts the current step ±1 to tolerate clock drift. */
function verifyTotp(secretBase32, token, timestampMs = Date.now(), stepSeconds = 30) {
  if (!/^\d{6}$/.test(String(token))) return false;
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  for (const c of [counter, counter - 1, counter + 1]) {
    const expected = hotp(secretBase32, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)))) {
      return true;
    }
  }
  return false;
}

function otpauthUrl(secretBase32, accountName, issuer = 'clomp') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, hotp, totp, verifyTotp, otpauthUrl, base32Encode, base32Decode };
