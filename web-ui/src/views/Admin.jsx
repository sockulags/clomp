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

function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState(null);

  const load = useCallback(() => {
    api.keys().then(res => setKeys(res.data.keys)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = async (e) => {
    e.preventDefault();
    const res = await api.createKey(name);
    setNewKey(res.data);
    setName('');
    load();
  };

  const revoke = async (k) => {
    await api.revokeKey(k.id);
    load();
  };

  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="hint">
        Machine writers (CI, services) append events with these keys. Keys are
        stored hashed — the full key is shown exactly once.
      </p>
      <table className="admin-table">
        <thead><tr><th>name</th><th>prefix</th><th>created</th><th></th></tr></thead>
        <tbody>
          {keys.map(k => (
            <tr key={k.id} className={k.revoked_at ? 'disabled-row' : ''}>
              <td>{k.name}</td>
              <td className="mono">{k.prefix}…</td>
              <td className="mono time">{String(k.created_at).slice(0, 10)}</td>
              <td className="row-actions">
                {k.revoked_at
                  ? <span className="hint">revoked</span>
                  : <button className="btn tiny" onClick={() => revoke(k)}>revoke</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {newKey && (
        <div className="one-time">
          <strong>Key “{newKey.name}”:</strong>
          <code className="mono">{newKey.key}</code>
          <span className="hint">Shown once — store it in your secret manager now.</span>
        </div>
      )}

      <form className="inline-form" onSubmit={create}>
        <input placeholder="key name (e.g. ci-bot)" value={name} onChange={e => setName(e.target.value)} required />
        <button className="btn primary" type="submit">Create key</button>
      </form>
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
