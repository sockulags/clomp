import React, { useState, useEffect } from 'react';
import api from '../api';

function Record({ user, onRecorded }) {
  const [catalog, setCatalog] = useState([]);
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState(user.email);
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [contextText, setContextText] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.catalog().then(res => setCatalog(res.data.actions)).catch(() => {});
  }, []);

  const selected = catalog.find(a => a.action === action);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let context;
      if (contextText.trim()) {
        try {
          context = JSON.parse(contextText);
        } catch {
          throw new Error('Context must be valid JSON (or empty)');
        }
      }

      const evidence = [];
      for (const file of files) {
        const res = await api.uploadEvidence(file);
        evidence.push(res.data);
      }

      const body = {
        action,
        actor: { type: 'user', id: actorId },
        ...(targetType || targetId ? { target: { type: targetType || 'unknown', id: targetId } } : {}),
        ...(context ? { context } : {}),
        ...(evidence.length ? { evidence } : {}),
        ...(occurredAt ? { occurred_at: new Date(occurredAt).toISOString() } : {})
      };

      const res = await api.createEvent(body);
      setResult(res.data);
      setTargetType(''); setTargetId(''); setContextText(''); setFiles([]); setOccurredAt('');
      onRecorded?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to record event');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="record-view">
      <form className="card" onSubmit={submit}>
        <h2>Record activity</h2>

        <label>
          Action
          <input
            list="action-catalog"
            value={action}
            onChange={e => setAction(e.target.value)}
            placeholder="access.review.completed"
            required
          />
          <datalist id="action-catalog">
            {catalog.map(a => <option key={a.action} value={a.action}>{a.title}</option>)}
          </datalist>
        </label>
        {selected && (
          <p className="framework-tags">
            <span title="SOC 2 trust-services criteria">SOC 2: {selected.soc2.join(', ')}</span>
            {' · '}
            <span title="NIS2 article">NIS2: {selected.nis2.join(', ')}</span>
          </p>
        )}

        <label>
          Actor
          <input value={actorId} onChange={e => setActorId(e.target.value)} required />
        </label>

        <div className="field-row">
          <label>
            Target type
            <input value={targetType} onChange={e => setTargetType(e.target.value)} placeholder="system" />
          </label>
          <label>
            Target id
            <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="web-01" />
          </label>
        </div>

        <label>
          Context <span className="hint">(JSON, optional)</span>
          <textarea
            value={contextText}
            onChange={e => setContextText(e.target.value)}
            placeholder='{"scope": "all production systems"}'
            rows={3}
          />
        </label>

        <label>
          Evidence <span className="hint">(files are hashed into the event)</span>
          <input type="file" multiple onChange={e => setFiles([...e.target.files])} />
        </label>

        <label>
          Occurred at <span className="hint">(optional — backfill is allowed and visible)</span>
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy || !action}>
          Append to ledger
        </button>
      </form>

      {result && (
        <div className="card result-card">
          <h3>Recorded ✔</h3>
          <p>
            Sequence <strong className="mono">#{result.event.sequence}</strong> is now part of the chain.
          </p>
          <p className="mono hash">{result.event.hash}</p>
          {!result.known_action && (
            <p className="warn">Note: this action is not in the seeded catalog — it will be flagged in reports.</p>
          )}
        </div>
      )}
    </section>
  );
}

export default Record;
