import React, { useState } from 'react';
import api from '../api';

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password, totp || undefined);
      onLogin(res.data.user);
    } catch (err) {
      if (err.response?.data?.totp_required) {
        setTotpRequired(true);
        setError('Enter your TOTP code (or a recovery code).');
      } else {
        setError(err.response?.data?.error || 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-name">clomp</span>
          <span className="brand-tag">tamper-evident audit trail</span>
        </div>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {totpRequired && (
          <label>
            TOTP / recovery code
            <input
              type="text"
              value={totp}
              onChange={e => setTotp(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
            />
          </label>
        )}

        {error && <p className="form-error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy}>
          Sign in
        </button>

        <p className="login-hint">
          First run? Create an admin with <code>npm run create-admin -- you@example.com</code> on the server.
        </p>
      </form>
    </div>
  );
}

export default Login;
