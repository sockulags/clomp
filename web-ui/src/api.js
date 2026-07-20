import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const client = axios.create({
  baseURL: API_URL,
  withCredentials: true
});

export const api = {
  // auth
  me: () => client.get('/auth/me'),
  login: (email, password, totp) => client.post('/auth/login', { email, password, totp }),
  logout: () => client.post('/auth/logout'),
  changePassword: (current_password, new_password) => client.post('/auth/change-password', { current_password, new_password }),
  sessions: () => client.get('/auth/sessions'),
  revokeSession: (id) => client.delete(`/auth/sessions/${id}`),
  revokeOtherSessions: () => client.post('/auth/sessions/revoke-others'),
  passkeyConfig: () => client.get('/auth/passkeys/config'),
  passkeys: () => client.get('/auth/passkeys'),
  passkeyRegisterOptions: (password) => client.post('/auth/passkeys/register/options', { password }),
  passkeyRegisterVerify: (challenge_id, response, name) => client.post('/auth/passkeys/register/verify', { challenge_id, response, name }),
  passkeyDelete: (id) => client.delete(`/auth/passkeys/${id}`),
  passkeyLoginOptions: (email) => client.post('/auth/passkeys/login/options', { email }),
  passkeyLoginVerify: (challenge_id, response) => client.post('/auth/passkeys/login/verify', { challenge_id, response }),
  totpSetup: (password) => client.post('/auth/totp/setup', password ? { password } : {}),
  totpEnable: (code) => client.post('/auth/totp/enable', { code }),
  totpDisable: (password) => client.post('/auth/totp/disable', { password }),

  // events
  catalog: () => client.get('/events/catalog'),
  events: (params) => client.get('/events', { params }),
  createEvent: (body) => client.post('/events', body),
  verify: () => client.get('/verify'),

  // schedules
  schedules: () => client.get('/schedules'),
  createSchedule: (body) => client.post('/schedules', body),
  patchSchedule: (id, body) => client.patch(`/schedules/${id}`, body),
  deleteSchedule: (id) => client.delete(`/schedules/${id}`),

  // evidence
  uploadEvidence: (file) => {
    const form = new FormData();
    form.append('file', file);
    return client.post('/evidence', form);
  },

  // admin
  users: () => client.get('/users'),
  createUser: (body) => client.post('/users', body),
  patchUser: (id, body) => client.patch(`/users/${id}`, body),
  resetPassword: (id) => client.post(`/users/${id}/reset-password`),
  keys: () => client.get('/keys'),
  createKey: (name, expires_at) => client.post('/keys', { name, ...(expires_at && { expires_at }) }),
  rotateKey: (id, expires_at) => client.post(`/keys/${id}/rotate`, expires_at ? { expires_at } : {}),
  revokeKey: (id) => client.delete(`/keys/${id}`)
};

export const exportUrls = {
  jsonl: (from, to) => `${API_URL}/export/jsonl?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`,
  report: (from, to, framework) => `${API_URL}/export/report?${new URLSearchParams({
    ...(from && { from }), ...(to && { to }),
    ...(framework && framework !== 'all' && { framework })
  })}`
};

export default api;
