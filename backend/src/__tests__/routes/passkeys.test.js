const request = require('supertest');
const express = require('express');
const argon2 = require('argon2');

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

const mockGenerateRegistrationOptions = jest.fn();
const mockVerifyRegistrationResponse = jest.fn();
const mockGenerateAuthenticationOptions = jest.fn();
const mockVerifyAuthenticationResponse = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...a) => mockGenerateRegistrationOptions(...a),
  verifyRegistrationResponse: (...a) => mockVerifyRegistrationResponse(...a),
  generateAuthenticationOptions: (...a) => mockGenerateAuthenticationOptions(...a),
  verifyAuthenticationResponse: (...a) => mockVerifyAuthenticationResponse(...a)
}));

// In-memory store answering the SQL passkeys.js and session.js issue.
let store;

const mockPool = {
  query: jest.fn(async (sql, params) => {
    if (sql.includes('DELETE FROM webauthn_challenges WHERE expires_at')) {
      store.challenges = store.challenges.filter(c => new Date(c.expires_at) > new Date());
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO webauthn_challenges')) {
      store.challenges.push({ id: params[0], user_id: params[1], challenge: params[2], type: params[3], expires_at: params[4] });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM webauthn_challenges WHERE id')) {
      const idx = store.challenges.findIndex(c => c.id === params[0] && c.type === params[1] && new Date(c.expires_at) > new Date());
      if (idx === -1) return { rows: [] };
      const [ch] = store.challenges.splice(idx, 1);
      return { rows: [{ user_id: ch.user_id, challenge: ch.challenge }] };
    }
    if (sql.includes('SELECT password_hash FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ password_hash: user.password_hash }] : [] };
    }
    if (sql.includes('SELECT credential_id, transports FROM passkeys')) {
      return { rows: store.passkeys.filter(p => p.user_id === params[0]) };
    }
    if (sql.includes('SELECT id, name, created_at, last_used_at FROM passkeys')) {
      return { rows: store.passkeys.filter(p => p.user_id === params[0]) };
    }
    if (sql.includes('INSERT INTO passkeys')) {
      if (store.passkeys.some(p => p.credential_id === params[2])) {
        const err = new Error('duplicate'); err.code = '23505'; throw err;
      }
      store.passkeys.push({ id: params[0], user_id: params[1], credential_id: params[2], public_key: params[3], counter: params[4], transports: params[5], name: params[6] });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM passkeys')) {
      const before = store.passkeys.length;
      store.passkeys = store.passkeys.filter(p => !(p.id === params[0] && p.user_id === params[1]));
      return { rowCount: before - store.passkeys.length, rows: [] };
    }
    if (sql.includes('FROM passkeys p') && sql.includes('u.email = $1')) {
      const user = store.users.find(u => u.email === params[0] && !u.disabled);
      if (!user) return { rows: [] };
      return { rows: store.passkeys.filter(p => p.user_id === user.id).map(p => ({ ...p, user_id: user.id })) };
    }
    if (sql.includes('FROM passkeys p') && sql.includes('p.credential_id = $1')) {
      const pk = store.passkeys.find(p => p.credential_id === params[0]);
      if (!pk) return { rows: [] };
      const user = store.users.find(u => u.id === pk.user_id);
      return { rows: [{ ...pk, email: user.email, name: user.name, role: user.role, disabled: user.disabled }] };
    }
    if (sql.includes('UPDATE passkeys SET counter')) {
      const pk = store.passkeys.find(p => p.id === params[1]);
      pk.counter = params[0];
      pk.last_used_at = new Date();
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO sessions')) {
      store.sessions.push({ token_hash: params[2], user_id: params[1] });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  })
};

jest.mock('../../database', () => ({
  getPool: () => mockPool
}));

const passkeyRoutes = require('../../routes/passkeys');

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
let passwordHash;

function appAs(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/auth/passkeys', passkeyRoutes);
  return app;
}

const USER = { id: 'u1', tenant_id: TENANT, email: 'lucas@example.com', name: 'Lucas', role: 'admin' };

beforeAll(async () => {
  passwordHash = await argon2.hash('correct-horse');
});

describe('passkey routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBAUTHN_ORIGIN;
    delete process.env.WEBAUTHN_RP_ID;
    store = {
      users: [{ ...USER, password_hash: passwordHash, disabled: false }],
      passkeys: [],
      challenges: [],
      sessions: []
    };
  });

  test('config reports disabled without WEBAUTHN_ORIGIN and ceremonies 501', async () => {
    const app = appAs(USER);
    const cfg = await request(app).get('/api/auth/passkeys/config');
    expect(cfg.body).toEqual({ enabled: false });

    const res = await request(app).post('/api/auth/passkeys/register/options').send({ password: 'correct-horse' });
    expect(res.status).toBe(501);
  });

  describe('with WEBAUTHN_ORIGIN configured', () => {
    beforeEach(() => {
      process.env.WEBAUTHN_ORIGIN = 'https://clomp.example.com';
      mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' });
      mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' });
    });

    test('config reports enabled and derives the RP ID from the origin', async () => {
      const app = appAs(USER);
      expect((await request(app).get('/api/auth/passkeys/config')).body).toEqual({ enabled: true });

      await request(app).post('/api/auth/passkeys/register/options').send({ password: 'correct-horse' });
      expect(mockGenerateRegistrationOptions.mock.calls[0][0].rpID).toBe('clomp.example.com');
    });

    test('registration requires the account password', async () => {
      const app = appAs(USER);
      const bad = await request(app).post('/api/auth/passkeys/register/options').send({ password: 'wrong' });
      expect(bad.status).toBe(401);
      const ok = await request(app).post('/api/auth/passkeys/register/options').send({ password: 'correct-horse' });
      expect(ok.status).toBe(200);
      expect(ok.body.challenge_id).toBeDefined();
    });

    test('full registration ceremony stores the credential', async () => {
      const app = appAs(USER);
      const opts = await request(app).post('/api/auth/passkeys/register/options').send({ password: 'correct-horse' });

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] }
        }
      });

      const verify = await request(app).post('/api/auth/passkeys/register/verify')
        .send({ challenge_id: opts.body.challenge_id, response: { id: 'cred-1' }, name: 'work laptop' });
      expect(verify.status).toBe(201);
      expect(store.passkeys).toHaveLength(1);
      expect(store.passkeys[0].name).toBe('work laptop');
      expect(mockVerifyRegistrationResponse.mock.calls[0][0].expectedChallenge).toBe('reg-challenge');

      // Challenge is single-use.
      const replay = await request(app).post('/api/auth/passkeys/register/verify')
        .send({ challenge_id: opts.body.challenge_id, response: { id: 'cred-1' } });
      expect(replay.status).toBe(400);
    });

    test('login ceremony creates a session and updates the counter', async () => {
      store.passkeys.push({
        id: 'pk1', user_id: 'u1', credential_id: 'cred-1',
        public_key: Buffer.from([1, 2, 3]).toString('base64url'), counter: 5, transports: 'internal', name: null
      });
      const app = appAs(null); // anonymous

      const opts = await request(app).post('/api/auth/passkeys/login/options').send({ email: 'lucas@example.com' });
      expect(opts.status).toBe(200);

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 6 }
      });

      const verify = await request(app).post('/api/auth/passkeys/login/verify')
        .send({ challenge_id: opts.body.challenge_id, response: { id: 'cred-1' } });
      expect(verify.status).toBe(200);
      expect(verify.body.user.email).toBe('lucas@example.com');
      expect(verify.headers['set-cookie'][0]).toContain('clomp_session=');
      expect(store.passkeys[0].counter).toBe(6);
      expect(store.sessions).toHaveLength(1);
    });

    test('login options do not reveal whether an email exists', async () => {
      const app = appAs(null);
      const known = await request(app).post('/api/auth/passkeys/login/options').send({ email: 'lucas@example.com' });
      const unknown = await request(app).post('/api/auth/passkeys/login/options').send({ email: 'nobody@example.com' });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(unknown.body.challenge_id).toBeDefined();
    });

    test('a challenge issued for one user rejects another user\'s credential', async () => {
      store.users.push({ id: 'u2', tenant_id: TENANT, email: 'other@example.com', name: 'Other', role: 'editor', password_hash: passwordHash, disabled: false });
      store.passkeys.push(
        { id: 'pk1', user_id: 'u1', credential_id: 'cred-1', public_key: 'AQID', counter: 0, transports: null, name: null },
        { id: 'pk2', user_id: 'u2', credential_id: 'cred-2', public_key: 'AQID', counter: 0, transports: null, name: null }
      );
      const app = appAs(null);

      const opts = await request(app).post('/api/auth/passkeys/login/options').send({ email: 'lucas@example.com' });
      const res = await request(app).post('/api/auth/passkeys/login/verify')
        .send({ challenge_id: opts.body.challenge_id, response: { id: 'cred-2' } });
      expect(res.status).toBe(401);
      expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    test('failed WebAuthn verification is a 401, not a session', async () => {
      store.passkeys.push({ id: 'pk1', user_id: 'u1', credential_id: 'cred-1', public_key: 'AQID', counter: 0, transports: null, name: null });
      const app = appAs(null);
      const opts = await request(app).post('/api/auth/passkeys/login/options').send({ email: 'lucas@example.com' });

      mockVerifyAuthenticationResponse.mockRejectedValue(new Error('signature invalid'));
      const res = await request(app).post('/api/auth/passkeys/login/verify')
        .send({ challenge_id: opts.body.challenge_id, response: { id: 'cred-1' } });
      expect(res.status).toBe(401);
      expect(store.sessions).toHaveLength(0);
    });

    test('removing a passkey is scoped to the owner', async () => {
      store.passkeys.push({ id: 'pk1', user_id: 'other-user', credential_id: 'cred-1', public_key: 'AQID', counter: 0, transports: null, name: null });
      const app = appAs(USER);
      const res = await request(app).delete('/api/auth/passkeys/pk1');
      expect(res.status).toBe(404);
      expect(store.passkeys).toHaveLength(1);
    });

    test('listing requires authentication', async () => {
      const app = appAs(null);
      expect((await request(app).get('/api/auth/passkeys')).status).toBe(401);
    });
  });
});
