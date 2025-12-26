import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

function App() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    level: '',
    startTime: '',
    endTime: '',
    correlationId: ''
  });
  const [selectedLog, setSelectedLog] = useState(null);
  const [apiKey, setApiKey] = useState(localStorage.getItem('apiKey') || 'test-api-key-123');
  const [service, setService] = useState('default-service');

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [filters, apiKey, service]);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.level) params.append('level', filters.level);
      if (filters.startTime) params.append('start_time', filters.startTime);
      if (filters.endTime) params.append('end_time', filters.endTime);
      if (filters.correlationId) params.append('correlation_id', filters.correlationId);
      params.append('limit', '100');

      const response = await axios.get(`${API_URL}/logs?${params}`, {
        headers: { 'X-API-Key': apiKey }
      });
      
      setLogs(response.data.logs || []);
    } catch (error) {
      console.error('Failed to fetch logs:', error);
      if (error.response?.status === 401) {
        alert('Ogiltig API-nyckel');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const getLevelColor = (level) => {
    switch (level) {
      case 'error': return '#dc3545';
      case 'warn': return '#ffc107';
      case 'info': return '#17a2b8';
      case 'debug': return '#6c757d';
      default: return '#6c757d';
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString('sv-SE');
  };

  const handleApiKeyChange = (newKey) => {
    setApiKey(newKey);
    localStorage.setItem('apiKey', newKey);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>📦 Loggplattform</h1>
        <div className="header-controls">
          <input
            type="text"
            placeholder="API-nyckel"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            className="api-key-input"
          />
          <input
            type="text"
            placeholder="Tjänst"
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="service-input"
          />
        </div>
      </header>

      <div className="filters">
        <select
          value={filters.level}
          onChange={(e) => handleFilterChange('level', e.target.value)}
          className="filter-select"
        >
          <option value="">Alla nivåer</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>

        <input
          type="datetime-local"
          value={filters.startTime}
          onChange={(e) => handleFilterChange('startTime', e.target.value)}
          placeholder="Från tid"
          className="filter-input"
        />

        <input
          type="datetime-local"
          value={filters.endTime}
          onChange={(e) => handleFilterChange('endTime', e.target.value)}
          placeholder="Till tid"
          className="filter-input"
        />

        <input
          type="text"
          value={filters.correlationId}
          onChange={(e) => handleFilterChange('correlationId', e.target.value)}
          placeholder="Korrelations-ID"
          className="filter-input"
        />

        <button onClick={fetchLogs} className="refresh-btn">
          🔄 Uppdatera
        </button>
      </div>

      {loading && logs.length === 0 ? (
        <div className="loading">Laddar loggar...</div>
      ) : (
        <div className="logs-container">
          <div className="logs-list">
            <h2>Loggar ({logs.length})</h2>
            {logs.length === 0 ? (
              <div className="no-logs">Inga loggar hittades</div>
            ) : (
              <div className="logs-timeline">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="log-entry"
                    onClick={() => setSelectedLog(log)}
                    style={{ borderLeftColor: getLevelColor(log.level) }}
                  >
                    <div className="log-header">
                      <span className="log-level" style={{ color: getLevelColor(log.level) }}>
                        {log.level.toUpperCase()}
                      </span>
                      <span className="log-time">{formatDate(log.timestamp)}</span>
                    </div>
                    <div className="log-message">{log.message}</div>
                    {log.correlationId && (
                      <div className="log-correlation">🔗 {log.correlationId}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedLog && (
            <div className="log-detail">
              <button className="close-btn" onClick={() => setSelectedLog(null)}>
                ✕
              </button>
              <h2>Logg Detaljer</h2>
              <div className="detail-section">
                <strong>ID:</strong> {selectedLog.id}
              </div>
              <div className="detail-section">
                <strong>Tid:</strong> {formatDate(selectedLog.timestamp)}
              </div>
              <div className="detail-section">
                <strong>Nivå:</strong>{' '}
                <span style={{ color: getLevelColor(selectedLog.level) }}>
                  {selectedLog.level.toUpperCase()}
                </span>
              </div>
              <div className="detail-section">
                <strong>Tjänst:</strong> {selectedLog.service}
              </div>
              <div className="detail-section">
                <strong>Meddelande:</strong>
                <div className="detail-message">{selectedLog.message}</div>
              </div>
              {selectedLog.correlationId && (
                <div className="detail-section">
                  <strong>Korrelations-ID:</strong> {selectedLog.correlationId}
                </div>
              )}
              {selectedLog.context && Object.keys(selectedLog.context).length > 0 && (
                <div className="detail-section">
                  <strong>Kontext:</strong>
                  <pre className="detail-context">
                    {JSON.stringify(selectedLog.context, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
