import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';

function EventRow({ event }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="event-row" onClick={() => setOpen(o => !o)}>
        <td className="mono seq">#{event.sequence}</td>
        <td className="mono action">{event.action}</td>
        <td>{event.actor?.type}/{event.actor?.id}</td>
        <td>{event.target ? `${event.target.type || ''}/${event.target.id || ''}` : '—'}</td>
        <td className="mono time">{event.occurred_at?.replace('T', ' ').slice(0, 19)}</td>
        <td className="evidence-count">{Array.isArray(event.evidence) && event.evidence.length ? `${event.evidence.length} 📎` : ''}</td>
      </tr>
      {open && (
        <tr className="event-detail">
          <td colSpan={6}>
            <dl>
              <dt>recorded</dt><dd className="mono">{event.recorded_at}</dd>
              <dt>hash</dt><dd className="mono hash">{event.hash}</dd>
              <dt>prev</dt><dd className="mono hash">{event.prev_hash}</dd>
              {event.context && (<><dt>context</dt><dd><pre>{JSON.stringify(event.context, null, 2)}</pre></dd></>)}
              {Array.isArray(event.evidence) && event.evidence.length > 0 && (
                <>
                  <dt>evidence</dt>
                  <dd>
                    {event.evidence.map((ev, i) => (
                      <div key={i}>
                        <a href={`/api/evidence/${ev.sha256}`} onClick={e => e.stopPropagation()}>
                          {ev.filename || ev.sha256.slice(0, 12)}
                        </a>
                        <span className="mono hash"> {ev.sha256.slice(0, 16)}…</span>
                      </div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function Ledger() {
  const [events, setEvents] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [filters, setFilters] = useState({ q: '', action: '', actor_id: '', from: '', to: '' });
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    api.catalog().then(res => setCatalog(res.data.actions)).catch(() => {});
  }, []);

  // Debounce the search box into the filters so we don't query on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => (prev.q === search ? prev : { ...prev, q: search }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (before = null, append = false) => {
    // Overlapping loads (typing while a slow request is in flight) may resolve
    // out of order; only the latest request is allowed to update the list.
    const reqId = ++requestSeq.current;
    try {
      const params = { limit: 50 };
      if (filters.q) params.q = filters.q;
      if (filters.action) params.action = filters.action;
      if (filters.actor_id) params.actor_id = filters.actor_id;
      if (filters.from) params.from = new Date(filters.from).toISOString();
      if (filters.to) params.to = new Date(filters.to).toISOString();
      if (before) params.before_sequence = before;

      const res = await api.events(params);
      if (reqId !== requestSeq.current) return;
      setEvents(prev => append ? [...prev, ...res.data.events] : res.data.events);
      setHasMore(res.data.has_more);
      setNextBefore(res.data.next_before_sequence);
      setError(null);
    } catch (err) {
      if (reqId !== requestSeq.current) return;
      if (!append) {
        // A failed reload must not leave a stale keyset cursor behind.
        setHasMore(false);
        setNextBefore(null);
      }
      setError(err.response?.data?.error || 'Failed to load events');
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  return (
    <section>
      <div className="filter-bar">
        <input
          type="search"
          className="search-box"
          placeholder="search events…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={filters.action} onChange={e => setFilter('action', e.target.value)}>
          <option value="">all actions</option>
          {catalog.map(a => <option key={a.action} value={a.action}>{a.action}</option>)}
        </select>
        <input placeholder="actor id" value={filters.actor_id} onChange={e => setFilter('actor_id', e.target.value)} />
        <input type="datetime-local" value={filters.from} onChange={e => setFilter('from', e.target.value)} />
        <span className="filter-sep">→</span>
        <input type="datetime-local" value={filters.to} onChange={e => setFilter('to', e.target.value)} />
      </div>

      {error && <p className="form-error">{error}</p>}

      <table className="ledger">
        <thead>
          <tr>
            <th>seq</th><th>action</th><th>actor</th><th>target</th><th>occurred</th><th></th>
          </tr>
        </thead>
        <tbody>
          {events.map(event => <EventRow key={event.id} event={event} />)}
          {events.length === 0 && !error && (
            <tr><td colSpan={6} className="empty">No events yet. The ledger starts with the first recorded activity.</td></tr>
          )}
        </tbody>
      </table>

      {hasMore && (
        <button className="btn ghost load-more" onClick={() => load(nextBefore, true)}>
          Load older events
        </button>
      )}
    </section>
  );
}

export default Ledger;
