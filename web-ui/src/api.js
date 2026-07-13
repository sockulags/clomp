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
  totpSetup: () => client.post('/auth/totp/setup'),
  totpEnable: (code) => client.post('/auth/totp/enable', { code }),
  totpDisable: (password) => client.post('/auth/totp/disable', { password }),

  // events
  catalog: () => client.get('/events/catalog'),
  events: (params) => client.get('/events', { params }),
  createEvent: (body) => client.post('/events', body),
  verify: () => client.get('/verify'),

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
  createKey: (name) => client.post('/keys', { name }),
  revokeKey: (id) => client.delete(`/keys/${id}`)
};

export const exportUrls = {
  jsonl: (from, to) => `${API_URL}/export/jsonl?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`,
  report: (from, to) => `${API_URL}/export/report?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`
};

export default api;
