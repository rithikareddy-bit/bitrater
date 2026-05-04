'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 60_000;

const URL_TYPE_LABELS = {
  combined: 'Combined',
  master:   'Master',
  trailer:  'Trailer',
};

function formatTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Badge({ ok }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 700,
      background: ok ? '#14532d' : '#450a0a',
      color: ok ? '#4ade80' : '#f87171',
      border: `1px solid ${ok ? '#4ade80' : '#f87171'}`,
    }}>
      {ok ? 'OK' : 'FAIL'}
    </span>
  );
}

function TypeBadge({ type }) {
  const colors = {
    combined: { bg: '#1a3324', color: '#34d399' },
    master:   { bg: '#1e3a5f', color: '#60a5fa' },
    trailer:  { bg: '#2d1a33', color: '#c084fc' },
  };
  const c = colors[type] || { bg: '#1f2937', color: '#9ca3af' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: c.bg,
      color: c.color,
    }}>
      {URL_TYPE_LABELS[type] || type}
    </span>
  );
}

const FILTERS = [
  { key: 'all',     label: 'All' },
  { key: 'failed',  label: 'Failed only' },
  { key: 'combined', label: 'Combined' },
  { key: 'master',  label: 'Master' },
  { key: 'trailer', label: 'Trailers' },
];

export default function UrlHealthPage() {
  const [run, setRun] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/url-health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRun(data.no_runs ? null : data);
      setError(data.no_runs ? 'no_runs' : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const results = run?.results ?? [];

  const filtered = results.filter((r) => {
    if (filter === 'failed' && r.ok) return false;
    if (filter !== 'all' && filter !== 'failed' && r.url_type !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        (r.episode_id || '').toLowerCase().includes(q) ||
        (r.show_title || '').toLowerCase().includes(q) ||
        (r.episode_name || '').toLowerCase().includes(q) ||
        (r.url || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const summary = run?.summary;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>URL Health</h1>
        {run && (
          <span style={{ color: '#888', fontSize: 13 }}>
            Last checked: {formatTs(run.started_at)}
          </span>
        )}
        <button
          onClick={refresh}
          style={{
            marginLeft: 'auto',
            background: '#1e293b',
            border: '1px solid #334155',
            color: '#e8e8e8',
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total URLs', value: summary.total, color: '#e8e8e8' },
            { label: 'OK', value: summary.ok, color: '#4ade80' },
            { label: 'Failed', value: summary.failed, color: summary.failed > 0 ? '#f87171' : '#4ade80' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              background: '#111',
              border: '1px solid #222',
              borderRadius: 8,
              padding: '12px 20px',
              minWidth: 120,
            }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters + search */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              background: filter === f.key ? '#1e40af' : '#1e293b',
              border: `1px solid ${filter === f.key ? '#3b82f6' : '#334155'}`,
              color: '#e8e8e8',
              padding: '4px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: filter === f.key ? 700 : 400,
            }}
          >
            {f.label}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search episode ID or URL…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            marginLeft: 'auto',
            background: '#111',
            border: '1px solid #333',
            color: '#e8e8e8',
            padding: '5px 12px',
            borderRadius: 6,
            fontSize: 13,
            width: 280,
          }}
        />
      </div>

      {loading && <div style={{ color: '#888' }}>Loading…</div>}
      {error === 'no_runs' && (
        <div style={{ color: '#888', background: '#111', border: '1px solid #222', borderRadius: 8, padding: 24, textAlign: 'center' }}>
          No health check runs yet. The Lambda runs every hour automatically — or trigger it manually from AWS console.
        </div>
      )}
      {error && error !== 'no_runs' && <div style={{ color: '#f87171', marginBottom: 12 }}>Error: {error}</div>}

      {!loading && !error && (
        <>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
            Showing {filtered.length} of {results.length} URLs
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #222', color: '#888', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Type</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Show</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Episode</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>HTTP</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Latency</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>URL</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Error</th>
                  <th style={{ padding: '8px 12px', fontWeight: 600 }}>Checked</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={i}
                    style={{
                      borderBottom: '1px solid #1a1a1a',
                      background: r.ok ? 'transparent' : '#1a0a0a',
                    }}
                  >
                    <td style={{ padding: '8px 12px' }}><Badge ok={r.ok} /></td>
                    <td style={{ padding: '8px 12px' }}><TypeBadge type={r.url_type} /></td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: '#e8e8e8', maxWidth: 160, wordBreak: 'break-word' }}>
                      {r.show_title ?? '—'}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: '#a0aec0', whiteSpace: 'nowrap' }}>
                      {r.episode_number != null ? `EP ${r.episode_number}` : ''}
                      {r.episode_name ? ` · ${r.episode_name}` : ''}
                      {!r.episode_number && !r.episode_name ? '—' : ''}
                    </td>
                    <td style={{ padding: '8px 12px', color: r.status >= 200 && r.status < 300 ? '#4ade80' : '#f87171' }}>
                      {r.status ?? '—'}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#888' }}>
                      {r.latency_ms != null ? `${r.latency_ms}ms` : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', maxWidth: 320 }}>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#4da6ff', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}
                      >
                        {r.url?.replace(/\?.*$/, '') ?? '—'}
                      </a>
                    </td>
                    <td style={{ padding: '8px 12px', color: '#f87171', fontSize: 12, maxWidth: 240, wordBreak: 'break-word' }}>
                      {r.error ?? '—'}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#555', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {formatTs(r.checked_at)}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 24, color: '#555', textAlign: 'center' }}>
                      No results
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
