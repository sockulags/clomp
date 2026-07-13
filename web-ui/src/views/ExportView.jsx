import React, { useState } from 'react';
import { exportUrls } from '../api';

function ExportView() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const fromIso = from ? new Date(from).toISOString() : '';
  const toIso = to ? new Date(to).toISOString() : '';

  return (
    <section className="export-view">
      <div className="card">
        <h2>Export</h2>
        <p>
          Exports are what you hand to an auditor. The JSONL file is verifiable
          offline with <code>scripts/verify-export.js</code> — no access to this
          server needed. The PDF is a formatted report mapped to SOC 2 criteria
          and NIS2 articles.
        </p>

        <div className="field-row">
          <label>
            From
            <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} />
          </label>
        </div>

        <div className="button-row">
          <a className="btn primary" href={exportUrls.report(fromIso, toIso)}>
            Download PDF report
          </a>
          <a className="btn" href={exportUrls.jsonl(fromIso, toIso)}>
            Download JSONL (verifiable)
          </a>
        </div>

        <p className="hint">
          Leave the range empty to export everything.
        </p>
      </div>
    </section>
  );
}

export default ExportView;
