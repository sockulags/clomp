const request = require('supertest');
const express = require('express');
const argon2 = require('argon2');

// The login limiter is module-scoped; without this the suite trips it.
process.env.RATE_LIMIT_LOGIN_MAX = '1000';

jest.mock('../../logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), fatal: jest.fn()
}));

// In-memory user/session store answering the queries auth.js + session.js issue.
let store;

const mockPool = {
  query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM users WHERE email')) {
      return { rows: store.users.filter(u => u.email === params[0]) };
    }
    if (sql.includes('INSERT INTO sessions')) {
      store.sessions.push({ id: params[0], user_id: params[1], token_hash: params[2], expires_at: params[3] });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM sessions WHERE token_hash')) {
      store.sessions = store.sessions.filter(s => s.token_hash !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('FROM sessions s JOIN users u')) {
      const session = store.sessions.find(s => s.token_hash === params[0]);
      if (!session) return { rows: [] };
      const user = store.users.find(u => u.id === session.user_id && !u.disabled);
      return { rows: user ? [{ id: user.id, tenant_id: user.tenant_id, email: user.email, name: user.name, role: user.role }] : [] };
    }
    if (sql.includes('SELECT totp_secret FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ totp_secret: user.totp_secret }] : [] };
    }
    if (sql.includes('SELECT password_hash FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ password_hash: user.password_hash }] : [] };
    }
    if (sql.includes('UPDATE users SET totp_secret')) {
      const user = store.users.find(u => u.id === params[1]);
      user.totp_secret = params[0];
      user.totp_enabled = false;
      return { rows: [] };
    }
    if (sql.includes('UPDATE users SET totp_enabled = true')) {
      store.users.find(u => u.id === params[0]).totp_enabled = true;
      return { rows: [] };
    }
    if (sql.includes('UPDATE users SET totp_enabled = false')) {
      const user = store.users.find(u => u.id === params[0]);
      user.totp_enabled = false;
      user.totp_secret = null;
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM recovery_codes')) {
      store.recoveryCodes = store.recoveryCodes.filter(rc => rc.user_id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO recovery_codes')) {
      store.recoveryCodes.push({ id: params[0], user_id: params[1], code_hash: params[2], used_at: null });
      return { rows: [] };
    }
    if (sql.includes('FROM recovery_codes WHERE user_id')) {
      return { rows: store.recoveryCodes.filter(rc => rc.user_id === params[0] && !rc.used_at) };
    }
    if (sql.includes('UPDATE recovery_codes SET used_at')) {
      store.recoveryCodes.find(rc => rc.id === params[0]).used_at = new Date();
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  })
};

jest.mock('../../database', () => ({
  getPool: () => mockPool
}));

const authRoutes = require('../../routes/auth');
const { attachSession } = require('../../middleware/session');
const { totp: totpCode } = require('../../totp');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(attachSession);
  app.use('/api/auth', authRoutes);
  return app;
}

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
let passwordHash;

beforeAll(async () => {
  passwordHash = await argon2.hash('correct-horse');
});

describe('auth routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    store = {
      users: [{
        id: 'u1', tenant_id: TENANT, email: 'lucas@example.com', name: 'Lucas',
        role: 'admin', password_hash: passwordHash,
        totp_secret: null, totp_enabled: false, disabled: false
      }],
      sessions: [],
      recoveryCodes: []
    };
    app = makeApp();
  });

  test('login succeeds with correct credentials and sets the session cookie', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'Lucas@Example.com', password: 'correct-horse' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('lucas@example.com');
    expect(res.body.user).not.toHaveProperty('password_hash');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('clomp_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(store.sessions).toHaveLength(1);
  });

  test('login fails with wrong password, unknown email or disabled user', async () => {
    expect((await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'wrong' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'correct-horse' })).status).toBe(401);

    store.users[0].disabled = true;
    expect((await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' })).status).toBe(401);
  });

  test('login requires TOTP when enabled and accepts a valid code', async () => {
    const { generateSecret } = require('../../totp');
    const secret = generateSecret();
    store.users[0].totp_secret = secret;
    store.users[0].totp_enabled = true;

    const noCode = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    expect(noCode.status).toBe(401);
    expect(noCode.body.totp_required).toBe(true);

    const badCode = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse', totp: '000000' });
    expect(badCode.status).toBe(401);

    const goodCode = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse', totp: totpCode(secret) });
    expect(goodCode.status).toBe(200);
  });

  test('a recovery code works in place of TOTP and is single-use', async () => {
    const { generateSecret } = require('../../totp');
    store.users[0].totp_secret = generateSecret();
    store.users[0].totp_enabled = true;
    store.recoveryCodes.push({ id: 'rc1', user_id: 'u1', code_hash: await argon2.hash('recovercode99'), used_at: null });

    const first = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse', totp: 'recovercode99' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse', totp: 'recovercode99' });
    expect(second.status).toBe(401);
  });

  test('me returns the session user; logout destroys the session', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('lucas@example.com');

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(store.sessions).toHaveLength(0);

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  test('full TOTP lifecycle: setup, enable with code, disable with password', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const setup = await request(app).post('/api/auth/totp/setup').set('Cookie', cookie);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauth_url).toContain('otpauth://totp/');

    const badEnable = await request(app).post('/api/auth/totp/enable')
      .set('Cookie', cookie).send({ code: '000000' });
    expect(badEnable.status).toBe(400);

    const enable = await request(app).post('/api/auth/totp/enable')
      .set('Cookie', cookie).send({ code: totpCode(setup.body.secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.recovery_codes).toHaveLength(8);
    expect(store.users[0].totp_enabled).toBe(true);

    const badDisable = await request(app).post('/api/auth/totp/disable')
      .set('Cookie', cookie).send({ password: 'wrong' });
    expect(badDisable.status).toBe(401);

    const disable = await request(app).post('/api/auth/totp/disable')
      .set('Cookie', cookie).send({ password: 'correct-horse' });
    expect(disable.status).toBe(200);
    expect(store.users[0].totp_enabled).toBe(false);
    expect(store.users[0].totp_secret).toBeNull();
  });
});
