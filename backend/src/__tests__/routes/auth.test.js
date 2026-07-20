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

// Tenants default to active; a test can deactivate one via store.inactiveTenants.
const tenantActive = (tenantId) => !(store.inactiveTenants || []).includes(tenantId);

const mockPool = {
  query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM users u JOIN tenants t')) {
      return { rows: store.users.filter(u => u.email === params[0] && tenantActive(u.tenant_id)) };
    }
    if (sql.includes('INSERT INTO sessions')) {
      store.sessions.push({
        id: params[0], user_id: params[1], token_hash: params[2], expires_at: params[3],
        user_agent: params[4] ?? null, created_at: new Date(), last_used_at: new Date()
      });
      return { rows: [] };
    }
    if (sql.includes('UPDATE sessions SET last_used_at')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT id, token_hash, user_agent')) {
      return { rows: store.sessions.filter(s => s.user_id === params[0]) };
    }
    if (sql.includes('DELETE FROM sessions WHERE id = $1 AND user_id = $2')) {
      const before = store.sessions.length;
      store.sessions = store.sessions.filter(s => !(s.id === params[0] && s.user_id === params[1]));
      return { rowCount: before - store.sessions.length, rows: [] };
    }
    if (sql.includes('DELETE FROM sessions WHERE token_hash')) {
      store.sessions = store.sessions.filter(s => s.token_hash !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('FROM sessions s')) {
      const session = store.sessions.find(s => s.token_hash === params[0]);
      if (!session) return { rows: [] };
      const user = store.users.find(u => u.id === session.user_id && !u.disabled && tenantActive(u.tenant_id));
      return { rows: user ? [{ id: user.id, tenant_id: user.tenant_id, email: user.email, name: user.name, role: user.role }] : [] };
    }
    if (sql.includes('SELECT totp_secret FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ totp_secret: user.totp_secret }] : [] };
    }
    if (sql.includes('SELECT password_hash, totp_enabled FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ password_hash: user.password_hash, totp_enabled: user.totp_enabled }] : [] };
    }
    if (sql.includes('SELECT password_hash FROM users')) {
      const user = store.users.find(u => u.id === params[0]);
      return { rows: user ? [{ password_hash: user.password_hash }] : [] };
    }
    if (sql.includes('UPDATE users SET password_hash')) {
      store.users.find(u => u.id === params[1]).password_hash = params[0];
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2')) {
      const before = store.sessions.length;
      store.sessions = store.sessions.filter(s => !(s.user_id === params[0] && s.token_hash !== params[1]));
      return { rowCount: before - store.sessions.length, rows: [] };
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

  test('a soft-deactivated tenant blocks both login and existing sessions', async () => {
    // Sign in while the tenant is still active.
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    // Deactivate the tenant: the session stops resolving and login is refused.
    store.inactiveTenants = [TENANT];
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
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

  test('re-running TOTP setup while enabled requires the password', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const setup = await request(app).post('/api/auth/totp/setup').set('Cookie', cookie);
    await request(app).post('/api/auth/totp/enable')
      .set('Cookie', cookie).send({ code: totpCode(setup.body.secret) });
    expect(store.users[0].totp_enabled).toBe(true);

    // Without the password, an active TOTP must not be silently disarmed.
    const noPw = await request(app).post('/api/auth/totp/setup').set('Cookie', cookie);
    expect(noPw.status).toBe(401);
    expect(store.users[0].totp_enabled).toBe(true);

    const withPw = await request(app).post('/api/auth/totp/setup')
      .set('Cookie', cookie).send({ password: 'correct-horse' });
    expect(withPw.status).toBe(200);
  });

  test('change-password verifies the current password and enforces length', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const short = await request(app).post('/api/auth/change-password')
      .set('Cookie', cookie).send({ current_password: 'correct-horse', new_password: 'short' });
    expect(short.status).toBe(400);

    const wrong = await request(app).post('/api/auth/change-password')
      .set('Cookie', cookie).send({ current_password: 'nope', new_password: 'a-much-longer-password' });
    expect(wrong.status).toBe(401);

    const ok = await request(app).post('/api/auth/change-password')
      .set('Cookie', cookie).send({ current_password: 'correct-horse', new_password: 'a-much-longer-password' });
    expect(ok.status).toBe(200);

    // Old password no longer works, new one does.
    expect((await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'a-much-longer-password' })).status).toBe(200);
  });

  test('change-password revokes every other session but keeps the current one', async () => {
    const s1 = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const s2 = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie1 = s1.headers['set-cookie'][0].split(';')[0];
    const cookie2 = s2.headers['set-cookie'][0].split(';')[0];
    expect(store.sessions).toHaveLength(2);

    await request(app).post('/api/auth/change-password')
      .set('Cookie', cookie2).send({ current_password: 'correct-horse', new_password: 'a-much-longer-password' });

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie2)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie1)).status).toBe(401);
  });

  test('sessions can be listed, revoked individually and revoked in bulk', async () => {
    const s1 = await request(app).post('/api/auth/login')
      .set('User-Agent', 'Chrome-on-laptop')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const s2 = await request(app).post('/api/auth/login')
      .set('User-Agent', 'Firefox-on-desktop')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const cookie2 = s2.headers['set-cookie'][0].split(';')[0];

    const list = await request(app).get('/api/auth/sessions').set('Cookie', cookie2);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    const current = list.body.sessions.find(s => s.current);
    const other = list.body.sessions.find(s => !s.current);
    expect(current.user_agent).toBe('Firefox-on-desktop');
    expect(other.user_agent).toBe('Chrome-on-laptop');
    // token hashes never leak
    expect(JSON.stringify(list.body)).not.toContain('token');

    // revoke the other session by id
    const del = await request(app).delete(`/api/auth/sessions/${other.id}`).set('Cookie', cookie2);
    expect(del.status).toBe(200);
    const cookie1 = s1.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie1)).status).toBe(401);

    // bulk: sign in twice more, revoke-others keeps only the caller
    await request(app).post('/api/auth/login').send({ email: 'lucas@example.com', password: 'correct-horse' });
    const bulk = await request(app).post('/api/auth/sessions/revoke-others').set('Cookie', cookie2);
    expect(bulk.status).toBe(200);
    expect(bulk.body.revoked).toBe(1);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie2)).status).toBe(200);
  });

  test('a session cannot revoke another user\'s session', async () => {
    store.users.push({
      id: 'u2', tenant_id: TENANT, email: 'other@example.com', name: 'Other',
      role: 'editor', password_hash: passwordHash,
      totp_secret: null, totp_enabled: false, disabled: false
    });
    const mine = await request(app).post('/api/auth/login')
      .send({ email: 'lucas@example.com', password: 'correct-horse' });
    const theirs = await request(app).post('/api/auth/login')
      .send({ email: 'other@example.com', password: 'correct-horse' });
    const myCookie = mine.headers['set-cookie'][0].split(';')[0];
    const theirCookie = theirs.headers['set-cookie'][0].split(';')[0];

    const theirId = (await request(app).get('/api/auth/sessions').set('Cookie', theirCookie))
      .body.sessions[0].id;
    const res = await request(app).delete(`/api/auth/sessions/${theirId}`).set('Cookie', myCookie);
    expect(res.status).toBe(404);
    expect((await request(app).get('/api/auth/me').set('Cookie', theirCookie)).status).toBe(200);
  });

  test('change-password requires authentication', async () => {
    const res = await request(app).post('/api/auth/change-password')
      .send({ current_password: 'x', new_password: 'a-much-longer-password' });
    expect(res.status).toBe(401);
  });
});
