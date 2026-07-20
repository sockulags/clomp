import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';

function Users() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', name: '', role: 'editor' });
  const [oneTime, setOneTime] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.users().then(res => setUsers(res.data.users)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.createUser(form);
      setOneTime({ email: res.data.email, password: res.data.initial_password, label: 'Initial password' });
      setForm({ email: '', name: '', role: 'editor' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create user');
    }
  };

  const reset = async (u) => {
    const res = await api.resetPassword(u.id);
    setOneTime({ email: res.data.email, password: res.data.initial_password, label: 'New password (TOTP cleared)' });
  };

  const toggleDisabled = async (u) => {
    await api.patchUser(u.id, { disabled: !u.disabled });
    load();
  };

  return (
    <div className="card">
      <h2>Users</h2>
      <table className="admin-table">
        <thead><tr><th>email</th><th>name</th><th>role</th><th>totp</th><th></th></tr></thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} className={u.disabled ? 'disabled-row' : ''}>
              <td>{u.email}</td>
              <td>{u.name}</td>
              <td><span className="role-chip">{u.role}</span></td>
              <td>{u.totp_enabled ? 'on' : '—'}</td>
              <td className="row-actions">
                <button className="btn tiny" onClick={() => reset(u)}>reset pw</button>
                <button className="btn tiny" onClick={() => toggleDisabled(u)}>
                  {u.disabled ? 'enable' : 'disable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {oneTime && (
        <div className="one-time">
          <strong>{oneTime.label} for {oneTime.email}:</strong>
          <code className="mono">{oneTime.password}</code>
          <span className="hint">Shown once — share it over a safe channel.</span>
        </div>
      )}

      <form className="inline-form" onSubmit={create}>
        <input placeholder="email" type="email" value={form.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
        <input placeholder="name" value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
        <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
          <option value="admin">admin</option>
          <option value="editor">editor</option>
          <option value="auditor">auditor</option>
        </select>
        <button className="btn primary" type="submit">Add user</button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_DAYS = 30;

const EXPIRY_CHOICES = [
  { value: '', label: 'never expires' },
  { value: '30', label: 'expires in 30 days' },
  { value: '90', label: 'expires in 90 days' },
  { value: '365', label: 'expires in 1 year' }
];

function expiresAtFromChoice(days) {
  if (!days) return undefined;
  return new Date(Date.now() + Number(days) * DAY_MS).toISOString();
}

/** Lifecycle status of a key: revoked, expired, stale (unused 30+ days) or active. */
function keyStatus(k) {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now()) return 'expired';
  const lastActivity = k.last_used_at || k.created_at;
  if (Date.now() - new Date(lastActivity).getTime() > STALE_AFTER_DAYS * DAY_MS) return 'stale';
  return 'active';
}

function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.keys().then(res => setKeys(res.data.keys)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.createKey(name, expiresAtFromChoice(expiryDays));
      setNewKey({ ...res.data, label: 'Key' });
      setName('');
      setExpiryDays('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create key');
    }
  };

  const rotate = async (k) => {
    // Rotation revokes the live key immediately — services using it start
    // failing until the new secret is distributed.
    if (!window.confirm(`Rotate “${k.name}”? The current key stops working immediately.`)) return;
    setError(null);
    try {
      // Preserve the key's expiry policy: the replacement keeps the same
      // expires_at (the backend does not inherit it). An already-past expiry
      // is not carried over — the rotated key would be dead on arrival.
      const keepExpiry = k.expires_at && new Date(k.expires_at).getTime() > Date.now()
        ? k.expires_at : undefined;
      const res = await api.rotateKey(k.id, keepExpiry);
      setNewKey({ ...res.data, label: 'Rotated key' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rotate key');
    }
  };

  const revoke = async (k) => {
    setError(null);
    try {
      await api.revokeKey(k.id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to revoke key');
    }
  };

  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="hint">
        Machine writers (CI, services) append events with these keys. Keys are
        stored hashed — the full key is shown exactly once. Rotating a key
        revokes it and issues a replacement in one step.
      </p>
      <table className="admin-table">
        <thead><tr><th>name</th><th>prefix</th><th>created</th><th>expires</th><th>last used</th><th>status</th><th></th></tr></thead>
        <tbody>
          {keys.map(k => {
            const status = keyStatus(k);
            // Only revoked rows are struck through: an expired key still
            // offers actions (rotate mints a working replacement).
            return (
              <tr key={k.id} className={status === 'revoked' ? 'disabled-row' : ''}>
                <td>{k.name}</td>
                <td className="mono">{k.prefix}…</td>
                <td className="mono time">{String(k.created_at).slice(0, 10)}</td>
                <td className="mono time">{k.expires_at ? String(k.expires_at).slice(0, 10) : 'never'}</td>
                <td className="mono time">{k.last_used_at ? String(k.last_used_at).slice(0, 10) : 'never'}</td>
                <td><span className={`role-chip key-status-${status}`}>{status}</span></td>
                <td className="row-actions">
                  {status !== 'revoked' && (
                    <>
                      <button className="btn tiny" onClick={() => rotate(k)}>rotate</button>
                      <button className="btn tiny" onClick={() => revoke(k)}>revoke</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {newKey && (
        <div className="one-time">
          <strong>{newKey.label} “{newKey.name}”:</strong>
          <code className="mono">{newKey.key}</code>
          <span className="hint">Shown once — store it in your secret manager now.</span>
        </div>
      )}

      <form className="inline-form" onSubmit={create}>
        <input placeholder="key name (e.g. ci-bot)" value={name} onChange={e => setName(e.target.value)} required />
        <select value={expiryDays} onChange={e => setExpiryDays(e.target.value)} aria-label="Key expiry">
          {EXPIRY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button className="btn primary" type="submit">Create key</button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function Admin() {
  return (
    <section className="admin-view">
      <Users />
      <ApiKeys />
    </section>
  );
}

export default Admin;
