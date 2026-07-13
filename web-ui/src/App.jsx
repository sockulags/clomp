import React, { useState, useEffect, useCallback } from 'react';
import api from './api';
import Login from './views/Login';
import Ledger from './views/Ledger';
import Record from './views/Record';
import ExportView from './views/ExportView';
import Admin from './views/Admin';
import Security from './views/Security';
import './App.css';

const TABS = [
  { id: 'ledger', label: 'Ledger', roles: ['admin', 'editor', 'auditor'] },
  { id: 'record', label: 'Record', roles: ['admin', 'editor'] },
  { id: 'export', label: 'Export', roles: ['admin', 'editor', 'auditor'] },
  { id: 'admin', label: 'Admin', roles: ['admin'] },
  { id: 'security', label: 'Security', roles: ['admin', 'editor', 'auditor'] }
];

function App() {
  const [user, setUser] = useState(null);
  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState('ledger');
  const [chainStatus, setChainStatus] = useState(null);

  useEffect(() => {
    api.me()
      .then(res => setUser(res.data.user))
      .catch(() => setUser(null))
      .finally(() => setBooted(true));
  }, []);

  const refreshChainStatus = useCallback(() => {
    api.verify()
      .then(res => setChainStatus(res.data))
      .catch(() => setChainStatus(null));
  }, []);

  useEffect(() => {
    if (user) refreshChainStatus();
  }, [user, refreshChainStatus]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setTab('ledger');
    }
  };

  if (!booted) return <div className="app" />;

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  const visibleTabs = TABS.filter(t => t.roles.includes(user.role));

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="brand-name">clomp</span>
          <span className="brand-tag">tamper-evident audit trail</span>
        </div>
        {chainStatus && (
          <div className={`chain-badge ${chainStatus.intact ? 'ok' : 'broken'}`} title="Hash chain status">
            {chainStatus.intact
              ? `chain intact · ${chainStatus.verified} events`
              : `CHAIN BROKEN at #${chainStatus.firstBreak}`}
          </div>
        )}
        <div className="whoami">
          <span className="whoami-name">{user.name}</span>
          <span className="whoami-role">{user.role}</span>
          <button className="btn ghost" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      <nav className="tabs">
        {visibleTabs.map(t => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'ledger' && <Ledger />}
        {tab === 'record' && <Record user={user} onRecorded={refreshChainStatus} />}
        {tab === 'export' && <ExportView />}
        {tab === 'admin' && user.role === 'admin' && <Admin />}
        {tab === 'security' && <Security />}
      </main>
    </div>
  );
}

export default App;
