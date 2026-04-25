'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const POLL_INTERVAL_MS = 30_000;

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unsigned', label: 'Unsigned' },
  { key: 'near_expiry', label: 'Near expiry (<30m)' },
  { key: 'errored', label: 'Errored' },
];

function formatDuration(sec) {
  if (sec == null) return '—';
  if (sec < 0) return 'expired';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function Pill({ color, bg, children }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      color,
      background: bg,
      border: `1px solid ${color}`,
    }}>{children}</span>
  );
}

export default function SigningPage() {
  const [config, setConfig] = useState(null);
  const [latestRun, setLatestRun] = useState(null);
  const [runs, setRuns] = useState([]);
  const [status, setStatus] = useState({ rows: [], total: 0, filter_count: 0 });
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [resignBusy, setResignBusy] = useState({});
  const [expandedRun, setExpandedRun] = useState(null);
  const [error, setError] = useState(null);
  const [alerts, setAlerts] = useState([]);

  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    const checkJson = async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    };
    try {
      const [cfgRes, runsRes, statusRes, alertsRes] = await Promise.all([
        fetch('/api/signing/config').then(checkJson),
        fetch('/api/signing/runs?limit=20').then(checkJson),
        fetch(`/api/signing/status?filter=${filter}`).then(checkJson),
        fetch('/api/signing/alerts').then(checkJson).catch(() => ({ alerts: [] })),
      ]);
      setConfig(cfgRes);
      setRuns(runsRes.runs || []);
      setLatestRun(runsRes.runs?.[0] || null);
      setStatus(statusRes);
      setAlerts(alertsRes.alerts || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const resignOne = async (episodeId) => {
    setResignBusy((s) => ({ ...s, [episodeId]: true }));
    try {
      const res = await fetch('/api/signing/resign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode_id: episodeId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Re-sign failed: ${data.error || res.status}`);
      }
      await refresh();
    } finally {
      setResignBusy((s) => ({ ...s, [episodeId]: false }));
    }
  };

  const fullSweep = async () => {
    if (!window.confirm('Trigger a full resign sweep across all episodes?')) return;
    setSweeping(true);
    try {
      const res = await fetch('/api/signing/resign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Sweep failed: ${data.error || res.status}`);
      }
      await refresh();
    } finally {
      setSweeping(false);
    }
  };

  const lastRunErrored = (latestRun?.errors?.length || 0) > 0;

  return (
    <div style={{ background: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh', padding: '24px' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Signing</h1>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
            <Link href="/" style={{ color: '#888', textDecoration: 'none', fontSize: 13 }}>← Home</Link>
            <button
              onClick={fullSweep}
              disabled={sweeping}
              style={{
                padding: '8px 16px',
                background: sweeping ? '#333' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: sweeping ? 'wait' : 'pointer',
              }}
            >{sweeping ? 'Sweeping…' : 'Trigger full sweep now'}</button>
          </div>
        </div>

        {error && (
          <div style={{ background: '#4c1d1d', border: '1px solid #ef4444', borderRadius: 6, padding: 12, marginBottom: 16, color: '#fca5a5' }}>
            {error}
          </div>
        )}

        {alerts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {alerts.map((a, i) => {
              const isError = a.level === 'error';
              return (
                <div
                  key={i}
                  style={{
                    background: isError ? '#4c1d1d' : '#3f2d12',
                    border: `1px solid ${isError ? '#ef4444' : '#f59e0b'}`,
                    borderRadius: 6,
                    padding: 12,
                    color: isError ? '#fca5a5' : '#fcd34d',
                    fontSize: 13,
                  }}
                >
                  <strong style={{ marginRight: 6, textTransform: 'uppercase', fontSize: 11 }}>
                    {a.level}
                  </strong>
                  {a.message}
                </div>
              );
            })}
          </div>
        )}

        {/* Header strip */}
        <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
            <Stat label="Last sweep" value={formatTs(latestRun?.started_at)} />
            <Stat label="Duration" value={latestRun?.duration_s != null ? `${latestRun.duration_s.toFixed(1)}s` : '—'} />
            <Stat label="Updated" value={latestRun?.updated_count ?? '—'} />
            <Stat label="Skipped" value={latestRun?.skipped_count ?? '—'} />
            <Stat label="Errors" value={latestRun?.errors?.length ?? '—'} color={lastRunErrored ? '#f87171' : '#22c55e'} />
          </div>
          {config && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
              TTL: {formatDuration(config.ttl_seconds)} · Cron: {config.schedule_expression}
            </div>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '6px 12px',
                background: filter === f.key ? '#2563eb' : '#1f1f1f',
                color: filter === f.key ? 'white' : '#aaa',
                border: `1px solid ${filter === f.key ? '#2563eb' : '#333'}`,
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >{f.label}</button>
          ))}
          <div style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12, color: '#666' }}>
            {status.filter_count} / {status.total}
          </div>
        </div>

        {/* Per-episode table */}
        <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#111' }}>
                {['Show', 'Item', 'Signed?', 'Expires in', 'Last error', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #2a2a2a', color: '#888', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#666' }}>Loading…</td></tr>
              ) : status.rows.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#666' }}>No rows match this filter.</td></tr>
              ) : (
                status.rows.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #1f1f1f' }}>
                    <td style={{ padding: '10px 12px', color: '#ddd' }}>{row.show_title || row.show_slug}</td>
                    <td style={{ padding: '10px 12px', color: '#aaa' }}>
                      {row.kind === 'trailer'
                        ? `Trailer (${row.trailer_key})`
                        : `Ep ${row.episode_number ?? '?'} — ${row.episode_title || ''}`}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {row.is_signed
                        ? <Pill color="#22c55e" bg="rgba(34,197,94,0.08)">Signed</Pill>
                        : <Pill color="#f59e0b" bg="rgba(245,158,11,0.08)">Unsigned</Pill>}
                    </td>
                    <td style={{ padding: '10px 12px', color: row.expires_in_seconds != null && row.expires_in_seconds < 1800 ? '#f87171' : '#ccc' }}>
                      {formatDuration(row.expires_in_seconds)}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#f87171', fontSize: 11 }}>{row.last_error || ''}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <button
                        onClick={() => resignOne(row.id)}
                        disabled={resignBusy[row.id]}
                        style={{
                          padding: '4px 10px',
                          background: resignBusy[row.id] ? '#333' : '#1f1f1f',
                          color: '#aaa',
                          border: '1px solid #444',
                          borderRadius: 4,
                          fontSize: 11,
                          cursor: resignBusy[row.id] ? 'wait' : 'pointer',
                        }}
                      >{resignBusy[row.id] ? 'Signing…' : 'Re-sign'}</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Run history */}
        <h2 style={{ fontSize: 14, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 10px' }}>Run history</h2>
        <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#111' }}>
                {['Started', 'Duration', 'Updated', 'Skipped', 'Errors', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #2a2a2a', color: '#888', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const runId = run.started_at || `idx-${i}`;
                const isExpanded = expandedRun === runId;
                const errCount = run.errors?.length || 0;
                return (
                  <Fragment key={runId}>
                    <tr style={{ borderBottom: '1px solid #1f1f1f', cursor: errCount ? 'pointer' : 'default' }}
                        onClick={() => errCount && setExpandedRun(isExpanded ? null : runId)}>
                      <td style={{ padding: '10px 12px', color: '#ddd' }}>{formatTs(run.started_at)}</td>
                      <td style={{ padding: '10px 12px', color: '#aaa' }}>{run.duration_s != null ? `${run.duration_s.toFixed(1)}s` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#22c55e' }}>{run.updated_count}</td>
                      <td style={{ padding: '10px 12px', color: '#aaa' }}>{run.skipped_count}</td>
                      <td style={{ padding: '10px 12px', color: errCount ? '#f87171' : '#22c55e' }}>
                        {errCount}{errCount > 0 && <span style={{ marginLeft: 8, color: '#666' }}>{isExpanded ? '▼' : '▶'}</span>}
                      </td>
                      <td style={{ padding: '10px 12px' }}></td>
                    </tr>
                    {isExpanded && errCount > 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: '12px 24px', background: '#0e0e0e' }}>
                          {run.errors.map((e, ei) => (
                            <div key={ei} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: ei < run.errors.length - 1 ? '1px solid #1f1f1f' : 'none' }}>
                              <code style={{ color: '#aaa', fontSize: 11 }}>{e.episode_id}</code>
                              <span style={{ color: '#f87171', fontSize: 11, flex: 1 }}>{e.message}</span>
                              <button
                                onClick={(ev) => { ev.stopPropagation(); resignOne(e.episode_id); }}
                                style={{ padding: '3px 8px', background: '#1f1f1f', color: '#aaa', border: '1px solid #444', borderRadius: 4, fontSize: 10, cursor: 'pointer' }}
                              >Re-sign now</button>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {runs.length === 0 && !loading && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#666' }}>No runs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, color: color || '#e5e5e5', fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
