import React, { useState } from 'react';
import api from '../api';

function Security() {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const startSetup = async () => {
    setError(null);
    setMessage(null);
    setRecoveryCodes(null);
    const res = await api.totpSetup();
    setSetup(res.data);
  };

  const enable = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.totpEnable(code);
      setRecoveryCodes(res.data.recovery_codes);
      setSetup(null);
      setCode('');
      setMessage('TOTP is now enabled for your account.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to enable TOTP');
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.totpDisable(password);
      setPassword('');
      setRecoveryCodes(null);
      setMessage('TOTP disabled.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to disable TOTP');
    }
  };

  return (
    <section className="security-view">
      <div className="card">
        <h2>Two-factor authentication (TOTP)</h2>
        <p className="hint">
          Passkeys are on the roadmap; TOTP works everywhere today — including
          intranet installations without TLS.
        </p>

        {!setup && (
          <div className="button-row">
            <button className="btn primary" onClick={startSetup}>Set up TOTP</button>
          </div>
        )}

        {setup && (
          <form onSubmit={enable}>
            <p>Add this secret to your authenticator app:</p>
            <code className="mono block">{setup.secret}</code>
            <p className="hint mono block">{setup.otpauth_url}</p>
            <label>
              Enter the 6-digit code to confirm
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoFocus />
            </label>
            <button className="btn primary" type="submit">Enable TOTP</button>
          </form>
        )}

        {recoveryCodes && (
          <div className="one-time">
            <strong>Recovery codes</strong> — each works once, store them safely:
            <div className="recovery-grid">
              {recoveryCodes.map(rc => <code key={rc} className="mono">{rc}</code>)}
            </div>
          </div>
        )}

        <form className="inline-form" onSubmit={disable}>
          <input
            type="password"
            placeholder="password to disable TOTP"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!password}>Disable TOTP</button>
        </form>

        {message && <p className="ok-message">{message}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </section>
  );
}

export default Security;
