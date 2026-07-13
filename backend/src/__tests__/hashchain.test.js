const { GENESIS_HASH, eventHash, canonicalEventPayload } = require('../hashchain');

// Reference vectors. If any of these change, every existing chain in every
// installation breaks — treat a failure here as a release blocker, not a
// snapshot to update.
const EVENT_1 = {
  tenant_id: 't-1',
  sequence: 1,
  occurred_at: '2026-07-13T10:00:00.000Z',
  recorded_at: '2026-07-13T10:00:01.000Z',
  actor: { type: 'user', id: 'u1' },
  action: 'patch.applied',
  target: null,
  context: { b: 2, a: 1 },
  evidence: null
};
const EVENT_1_CANONICAL =
  '{"action":"patch.applied","actor":{"id":"u1","type":"user"},"context":{"a":1,"b":2},"evidence":null,' +
  '"occurred_at":"2026-07-13T10:00:00.000Z","recorded_at":"2026-07-13T10:00:01.000Z","sequence":1,' +
  '"target":null,"tenant_id":"t-1"}';
const EVENT_1_HASH = 'accaf060ff837758158f8b4994e428eb234e6bd905d0b7af30af7285e832c405';

const EVENT_2 = {
  tenant_id: 't-1',
  sequence: 2,
  occurred_at: '2026-07-13T11:00:00.000Z',
  recorded_at: '2026-07-13T11:00:01.000Z',
  actor: { type: 'user', id: 'u1' },
  action: 'incident.opened',
  target: { type: 'system', id: 'db' },
  context: null,
  evidence: [{ filename: 'x.pdf', sha256: 'a'.repeat(64), size: 10 }]
};
const EVENT_2_HASH = '6745d7ea8c00fa4ecd88db353dc73374c942ad83d7fe25d7f8a77b2f6250c0a3';

describe('hashchain', () => {
  test('genesis hash is 64 zero hex chars', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  test('canonical payload matches the reference vector', () => {
    expect(canonicalEventPayload(EVENT_1)).toBe(EVENT_1_CANONICAL);
  });

  test('event hashes match the reference vectors', () => {
    const h1 = eventHash(GENESIS_HASH, EVENT_1);
    expect(h1).toBe(EVENT_1_HASH);
    expect(eventHash(h1, EVENT_2)).toBe(EVENT_2_HASH);
  });

  test('missing target/context/evidence hash identically to explicit null', () => {
    const sparse = { ...EVENT_1, target: undefined, context: undefined, evidence: undefined };
    const explicit = { ...EVENT_1, target: null, context: null, evidence: null };
    expect(canonicalEventPayload(sparse)).toBe(canonicalEventPayload(explicit));
    expect(canonicalEventPayload(explicit)).toContain('"context":null');
  });

  test('any field change changes the hash', () => {
    const base = eventHash(GENESIS_HASH, EVENT_1);
    expect(eventHash(GENESIS_HASH, { ...EVENT_1, action: 'patch.appliedd' })).not.toBe(base);
    expect(eventHash(GENESIS_HASH, { ...EVENT_1, context: { a: 1, b: 3 } })).not.toBe(base);
    expect(eventHash(GENESIS_HASH, { ...EVENT_1, occurred_at: '2026-07-13T10:00:00.001Z' })).not.toBe(base);
  });

  test('rejects malformed prev_hash', () => {
    expect(() => eventHash('xyz', EVENT_1)).toThrow(/prev_hash/);
    expect(() => eventHash('A'.repeat(64), EVENT_1)).toThrow(/prev_hash/);
  });
});
