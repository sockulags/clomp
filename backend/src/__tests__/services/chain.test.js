// End-to-end coverage of appendEvent/verifyChain against an in-memory fake
// of the pg pool that answers the exact statements chain.js issues.

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

let store; // { events: [...] }

const mockClient = {
  query: jest.fn(async (sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT sequence, hash FROM events')) {
      const [tenantId] = params;
      const rows = store.events
        .filter(e => e.tenant_id === tenantId)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 1);
      return { rows };
    }
    if (sql.includes('INSERT INTO events')) {
      const [id, tenant_id, sequence, occurred_at, recorded_at, actor, action, target, context, evidence, prev_hash, hash] = params;
      store.events.push({
        id, tenant_id, sequence, occurred_at, recorded_at,
        actor: JSON.parse(actor), action,
        target: target === null ? null : JSON.parse(target),
        context: context === null ? null : JSON.parse(context),
        evidence: evidence === null ? null : JSON.parse(evidence),
        prev_hash, hash
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected client SQL: ${sql}`);
  }),
  release: jest.fn()
};

const mockPool = {
  connect: jest.fn(async () => mockClient),
  query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM checkpoints')) {
      const [tenantId, seq] = params;
      const rows = (store.checkpoints || [])
        .filter(c => c.tenant_id === tenantId && c.sequence === Number(seq))
        .sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at));
      return { rows };
    }
    if (sql.includes('MIN(sequence)')) {
      const [tenantId] = params;
      const seqs = store.events.filter(e => e.tenant_id === tenantId).map(e => e.sequence);
      return { rows: [{ min: seqs.length ? Math.min(...seqs) : null }] };
    }
    if (sql.includes('WHERE tenant_id = $1 AND sequence = $2')) {
      const [tenantId, seq] = params;
      return { rows: store.events.filter(e => e.tenant_id === tenantId && e.sequence === Number(seq)) };
    }
    if (sql.includes('sequence > $2')) {
      const [tenantId, cursor, maybeTo] = params;
      let rows = store.events.filter(e => e.tenant_id === tenantId && e.sequence > Number(cursor));
      if (sql.includes('sequence <= $3')) rows = rows.filter(e => e.sequence <= Number(maybeTo));
      rows.sort((a, b) => a.sequence - b.sequence);
      const limit = parseInt(sql.match(/LIMIT (\d+)/)[1]);
      return { rows: rows.slice(0, limit) };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  })
};

jest.mock('../../database', () => ({
  getPool: () => mockPool
}));

const { appendEvent, verifyChain } = require('../../services/chain');
const { GENESIS_HASH } = require('../../hashchain');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('chain service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store = { events: [], checkpoints: [] };
  });

  test('appendEvent assigns gap-free sequences and links hashes', async () => {
    const e1 = await appendEvent(TENANT, {
      actor: { type: 'user', id: 'u1' },
      action: 'patch.applied'
    });
    const e2 = await appendEvent(TENANT, {
      actor: { type: 'user', id: 'u1' },
      action: 'backup.tested',
      target: { type: 'system', id: 'db' }
    });

    expect(e1.sequence).toBe(1);
    expect(e1.prev_hash).toBe(GENESIS_HASH);
    expect(e2.sequence).toBe(2);
    expect(e2.prev_hash).toBe(e1.hash);
    expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [TENANT]);
  });

  test('appendEvent normalizes occurred_at to ISO milliseconds', async () => {
    const e = await appendEvent(TENANT, {
      occurredAt: '2026-07-01T08:00:00+02:00',
      actor: { type: 'user', id: 'u1' },
      action: 'risk.assessed'
    });
    expect(e.occurred_at).toBe('2026-07-01T06:00:00.000Z');
  });

  test('appendEvent rolls back on insert failure', async () => {
    const boom = new Error('insert failed');
    mockClient.query.mockImplementationOnce(async () => ({ rows: [] })) // BEGIN
      .mockImplementationOnce(async () => ({ rows: [] })) // lock
      .mockImplementationOnce(async () => ({ rows: [] })) // tip
      .mockImplementationOnce(async () => { throw boom; }); // INSERT

    await expect(appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'a.b' }))
      .rejects.toThrow('insert failed');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('verifyChain confirms an intact chain', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    const result = await verifyChain(TENANT);
    expect(result).toEqual({ intact: true, verified: 5 });
  });

  test('tenant chains are fully independent: own sequences, own genesis, isolated tampering', async () => {
    const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

    const a1 = await appendEvent(TENANT, { actor: { type: 'user', id: 'a' }, action: 'patch.applied' });
    const b1 = await appendEvent(TENANT_B, { actor: { type: 'user', id: 'b' }, action: 'backup.tested' });
    const a2 = await appendEvent(TENANT, { actor: { type: 'user', id: 'a' }, action: 'patch.applied' });

    // Each tenant starts its own chain at sequence 1 from the genesis hash;
    // interleaved writes never leak across.
    expect(a1.sequence).toBe(1);
    expect(b1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(b1.prev_hash).toBe(GENESIS_HASH);
    expect(a2.prev_hash).toBe(a1.hash);

    // Verification is per tenant and only counts that tenant's events.
    expect(await verifyChain(TENANT)).toEqual({ intact: true, verified: 2 });
    expect(await verifyChain(TENANT_B)).toEqual({ intact: true, verified: 1 });

    // Tampering with tenant B's chain must not affect tenant A's verdict.
    store.events.find(e => e.tenant_id === TENANT_B).action = 'forged.entry';
    expect((await verifyChain(TENANT_B)).intact).toBe(false);
    expect((await verifyChain(TENANT)).intact).toBe(true);
  });

  test('verifyChain detects a tampered payload', async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    // Simulate someone editing an event body directly in the database.
    store.events[1].action = 'training.completed.FAKED';

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(false);
    expect(result.firstBreak).toBe(2);
    expect(result.reason).toBe('hash mismatch');
    expect(result.verified).toBe(1);
  });

  test('verifyChain detects a re-hashed event via the prev_hash of its successor', async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    // Attacker edits event 2 AND recomputes its hash — the successor's
    // prev_hash still betrays the rewrite.
    const { eventHash } = require('../../hashchain');
    store.events[1].action = 'access.revoked';
    store.events[1].hash = eventHash(store.events[1].prev_hash, store.events[1]);

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(false);
    expect(result.firstBreak).toBe(3);
    expect(result.reason).toBe('prev_hash mismatch');
  });

  test('verifyChain detects sequence gaps', async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    store.events = store.events.filter(e => e.sequence !== 2);

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(false);
    expect(result.firstBreak).toBe(2);
    expect(result.reason).toBe('sequence gap');
  });

  test('verifyChain supports partial ranges', async () => {
    for (let i = 0; i < 4; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    const result = await verifyChain(TENANT, 3, 4);
    expect(result).toEqual({ intact: true, verified: 2 });

    const missing = await verifyChain('bbbbbbbb-0000-0000-0000-000000000002', 5);
    expect(missing.intact).toBe(false);
    expect(missing.reason).toBe('missing predecessor event');
  });

  test('verifyChain drives the last-verify metric only for genuine outcomes', async () => {
    const metrics = require('../../metrics');
    const gauge = metrics.register.getSingleMetric('clomp_chain_last_verify_ok');
    const gaugeValue = async () => {
      const { values } = await gauge.get();
      return values.find(v => v.labels.tenant_id === TENANT)?.value;
    };
    gauge.reset();

    for (let i = 0; i < 3; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'patch.applied' });
    }

    // Out-of-range request (missing predecessor) is benign: no recording,
    // so a stray ?from= query cannot raise a false tampering alarm.
    const missing = await verifyChain(TENANT, 999);
    expect(missing.reason).toBe('missing predecessor event');
    expect(await gaugeValue()).toBeUndefined();

    // An intact partial verify does not claim full-chain health.
    await verifyChain(TENANT, 2, 3);
    expect(await gaugeValue()).toBeUndefined();

    // A full verify records success...
    await verifyChain(TENANT);
    expect(await gaugeValue()).toBe(1);

    // ...and a genuine break (even in a partial range) records failure.
    store.events[1].action = 'tampered';
    await verifyChain(TENANT, 2, 3);
    expect(await gaugeValue()).toBe(0);
  });

  test('verifyChain on an empty chain is intact with zero verified', async () => {
    const result = await verifyChain(TENANT);
    expect(result).toEqual({ intact: true, verified: 0 });
  });

  test('verifyChain anchors a retention-pruned chain at a signed checkpoint', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    // Retention pruned sequences 1–2, cutting at a checkpoint of sequence 2.
    const anchorEvent = store.events.find(e => e.sequence === 2);
    store.checkpoints.push({
      tenant_id: TENANT, sequence: 2, hash: anchorEvent.hash,
      signed_at: '2026-07-01T02:00:00.000Z'
    });
    store.events = store.events.filter(e => e.sequence > 2);

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(true);
    expect(result.verified).toBe(3);
    expect(result.anchored_at).toEqual({ sequence: 2, hash: anchorEvent.hash });
  });

  test('verifyChain rejects pruned history without a matching checkpoint', async () => {
    for (let i = 0; i < 4; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    // History removed with no checkpoint attesting the cut point.
    store.events = store.events.filter(e => e.sequence > 2);

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(false);
    expect(result.firstBreak).toBe(3);
    expect(result.reason).toContain('without a matching signed checkpoint');
  });

  test('verifyChain rejects a pruned chain whose checkpoint hash disagrees', async () => {
    for (let i = 0; i < 4; i++) {
      await appendEvent(TENANT, { actor: { type: 'user', id: 'u1' }, action: 'training.completed' });
    }
    store.checkpoints.push({
      tenant_id: TENANT, sequence: 2, hash: 'f'.repeat(64),
      signed_at: '2026-07-01T02:00:00.000Z'
    });
    store.events = store.events.filter(e => e.sequence > 2);

    const result = await verifyChain(TENANT);
    expect(result.intact).toBe(false);
  });
});
