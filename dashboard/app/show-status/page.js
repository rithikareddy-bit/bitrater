'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const LANG_LABELS = {
  te: 'Telugu',
  hi: 'Hindi',
  kn: 'Kannada',
  ta: 'Tamil',
  ml: 'Malayalam',
  en: 'English',
};
const LANG_TABS = ['all', 'te', 'hi', 'kn', 'unknown'];

function langDisplay(code) {
  if (!code || code === 'unknown') return 'Unknown';
  if (code === 'all') return 'All';
  return LANG_LABELS[code] || code.toUpperCase();
}

const STATUS_STYLE = {
  full:    { color: '#22c55e', bg: 'rgba(34,197,94,0.10)', border: '#22c55e', label: 'Full combined' },
  partial: { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)', border: '#f59e0b', label: 'Partial' },
  none:    { color: '#ef4444', bg: 'rgba(239,68,68,0.10)', border: '#ef4444', label: 'No combined' },
  empty:   { color: '#94a3b8', bg: 'transparent',          border: '#444',    label: 'No episodes' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.empty;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 4,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

function LangPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? '#4da6ff' : '#333'}`,
        background: active ? '#1c2c44' : '#111',
        color: active ? '#bfdbfe' : '#aaa',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function SummaryCard({ label, value, color }) {
  return (
    <div
      style={{
        background: '#161616',
        border: '1px solid #2a2a2a',
        borderRadius: 8,
        padding: '12px 16px',
        minWidth: 130,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e2e8f0', marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

export default function ShowStatusPage() {
  const [activeLang, setActiveLang] = useState('all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | partial | none | full | empty
  const [expandedId, setExpandedId] = useState(null);
  const [activeRuns, setActiveRuns] = useState(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [activeError, setActiveError] = useState(null);
  const [activeOpen, setActiveOpen] = useState(false);

  const checkAll = () => {
    setActiveOpen(true);
    setActiveLoading(true);
    setActiveError(null);
    fetch('/api/show-status/active-runs')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setActiveRuns(d);
      })
      .catch((e) => setActiveError(e.message || 'Failed to load active runs'))
      .finally(() => setActiveLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/show-status?language=${encodeURIComponent(activeLang)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message || 'Failed to load show status'))
      .finally(() => setLoading(false));
  }, [activeLang]);

  const shows = data?.shows ?? [];
  const summary = data?.summary;

  const filteredShows = shows.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!(s.title || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: '#4da6ff' }}>← Catalog</Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Show status</h1>
        <span style={{ color: '#666', fontSize: 13 }}>
          Combined-link coverage by language
        </span>
        <button
          type="button"
          onClick={checkAll}
          style={{
            marginLeft: 'auto',
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid #4da6ff',
            background: '#1c2c44',
            color: '#bfdbfe',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Check all
        </button>
      </div>

      {activeOpen && (
        <ActiveRunsPanel
          data={activeRuns}
          loading={activeLoading}
          error={activeError}
          onClose={() => setActiveOpen(false)}
          onRefresh={checkAll}
        />
      )}

      <div
        style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '16px 18px',
          marginBottom: 18,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Language
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {LANG_TABS.map((code) => (
            <LangPill
              key={code}
              label={langDisplay(code)}
              active={activeLang === code}
              onClick={() => setActiveLang(code)}
            />
          ))}
        </div>

        {summary && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
            <SummaryCard label="Shows" value={summary.total_shows} />
            <SummaryCard label="Full combined" value={summary.full || 0} color="#22c55e" />
            <SummaryCard label="Partial" value={summary.partial || 0} color="#f59e0b" />
            <SummaryCard label="None" value={summary.none || 0} color="#ef4444" />
            <SummaryCard
              label="Episode coverage"
              value={summary.total_episodes
                ? `${summary.total_combined_episodes}/${summary.total_episodes}`
                : '0/0'}
              color="#4da6ff"
            />
          </div>
        )}
      </div>

      {loading && <p style={{ color: '#888' }}>Loading show status…</p>}
      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {!loading && !error && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <input
              type="search"
              placeholder="Search shows…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                flex: '1 1 240px',
                maxWidth: 320,
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #333',
                background: '#111',
                color: '#e8e8e8',
                fontSize: 13,
              }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['all', 'partial', 'none', 'full', 'empty'].map((s) => (
                <LangPill
                  key={s}
                  label={s === 'all' ? 'All status' : (STATUS_STYLE[s]?.label || s)}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
            </div>
            <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 12 }}>
              {filteredShows.length} of {shows.length} shows
            </span>
          </div>

          <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#111' }}>
                    {['Show', 'Language', 'Combined', 'Coverage', 'Status', ''].map((h) => (
                      <th
                        key={h || 'expand'}
                        style={{
                          textAlign: 'left',
                          padding: '10px 14px',
                          borderBottom: '1px solid #2a2a2a',
                          color: '#888',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          fontSize: 11,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredShows.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '20px 14px', color: '#666', textAlign: 'center' }}>
                        No shows match this filter.
                      </td>
                    </tr>
                  )}
                  {filteredShows.map((s, i) => {
                    const id = String(s._id);
                    const isExpanded = expandedId === id;
                    const pct = s.episode_total
                      ? Math.round((s.episode_combined / s.episode_total) * 100)
                      : 0;
                    return (
                      <ShowStatusRow
                        key={id}
                        show={s}
                        index={i}
                        pct={pct}
                        isExpanded={isExpanded}
                        onToggle={() => setExpandedId(isExpanded ? null : id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '12px 18px', fontSize: 11, color: '#555', lineHeight: 1.5 }}>
              Combined status checks the GCP/CDN URL in <code>master.showcache.episodes[].signed_playback_url</code>{' '}
              for the substring <code>combined</code>. <strong>Full</strong> = every episode combined.{' '}
              <strong>Partial</strong> = some episodes combined. <strong>None</strong> = zero combined episodes.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ActiveRunsPanel({ data, loading, error, onClose, onRefresh }) {
  const shows = data?.shows || [];
  const reruns = data?.reruns || [];
  const workers = data?.workers;
  const cellTh = {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '1px solid #2a2a2a',
    color: '#888',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };
  const cellTd = { padding: '8px 12px', fontSize: 13, color: '#cbd5e1', borderBottom: '1px solid #1e1e1e' };

  return (
    <div
      style={{
        background: '#161616',
        border: '1px solid #2a2a2a',
        borderRadius: 10,
        padding: '16px 18px',
        marginBottom: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
          Active pipeline runs
        </div>
        <span style={{ color: '#666', fontSize: 12 }}>
          {data ? `${data.active_runs} run(s), ${shows.length} show(s)` : ''}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #333',
            background: '#111',
            color: '#aaa',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #333',
            background: '#111',
            color: '#aaa',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>

      {loading && <p style={{ color: '#888', fontSize: 13 }}>Loading active runs…</p>}
      {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}

      {!loading && !error && data && (
        <>
          <div style={{ overflowX: 'auto', marginBottom: 18 }}>
            <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#111' }}>
                  <th style={cellTh}>Show</th>
                  <th style={cellTh}>Kind</th>
                  <th style={cellTh}>AWS H264</th>
                  <th style={cellTh}>AWS H265</th>
                  <th style={cellTh}>AWS total</th>
                  <th style={cellTh}>GCP H264</th>
                  <th style={cellTh}>GCP H265</th>
                  <th style={cellTh}>GCP total</th>
                </tr>
              </thead>
              <tbody>
                {shows.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...cellTd, color: '#666', textAlign: 'center' }}>
                      No active pipeline runs.
                    </td>
                  </tr>
                )}
                {shows.map((s) => (
                  <tr key={s.show_id}>
                    <td style={{ ...cellTd, color: '#e2e8f0', fontWeight: 500 }}>
                      {s.show_title}
                      <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>{s.show_slug || s.show_id}</div>
                    </td>
                    <td style={cellTd}>{s.kind}</td>
                    <td style={{ ...cellTd, color: s.aws_h264 ? '#fbbf24' : '#555' }}>{s.aws_h264 || 0}</td>
                    <td style={{ ...cellTd, color: s.aws_h265 ? '#fbbf24' : '#555' }}>{s.aws_h265 || 0}</td>
                    <td style={{ ...cellTd, color: s.aws_running ? '#fbbf24' : '#cbd5e1', fontWeight: 700 }}>
                      {s.aws_running}
                    </td>
                    <td style={{ ...cellTd, color: s.gcp_h264 ? '#4da6ff' : '#555' }}>{s.gcp_h264 || 0}</td>
                    <td style={{ ...cellTd, color: s.gcp_h265 ? '#4da6ff' : '#555' }}>{s.gcp_h265 || 0}</td>
                    <td style={{ ...cellTd, color: s.gcp_running ? '#4da6ff' : '#cbd5e1', fontWeight: 700 }}>
                      {s.gcp_running}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {reruns.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Per-episode reruns (no wrapping pipeline_runs doc)
              </div>
              <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#111' }}>
                    <th style={cellTh}>Show</th>
                    <th style={cellTh}>AWS H264</th>
                    <th style={cellTh}>AWS H265</th>
                    <th style={cellTh}>AWS total</th>
                    <th style={cellTh}>GCP H264</th>
                    <th style={cellTh}>GCP H265</th>
                    <th style={cellTh}>GCP total</th>
                  </tr>
                </thead>
                <tbody>
                  {reruns.map((s) => (
                    <tr key={`rerun-${s.show_id}`}>
                      <td style={{ ...cellTd, color: '#e2e8f0', fontWeight: 500 }}>
                        {s.show_title}
                        <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>{s.show_slug || s.show_id}</div>
                      </td>
                      <td style={{ ...cellTd, color: s.aws_h264 ? '#fbbf24' : '#555' }}>{s.aws_h264 || 0}</td>
                      <td style={{ ...cellTd, color: s.aws_h265 ? '#fbbf24' : '#555' }}>{s.aws_h265 || 0}</td>
                      <td style={{ ...cellTd, color: s.aws_running ? '#fbbf24' : '#cbd5e1', fontWeight: 700 }}>{s.aws_running}</td>
                      <td style={{ ...cellTd, color: s.gcp_h264 ? '#4da6ff' : '#555' }}>{s.gcp_h264 || 0}</td>
                      <td style={{ ...cellTd, color: s.gcp_h265 ? '#4da6ff' : '#555' }}>{s.gcp_h265 || 0}</td>
                      <td style={{ ...cellTd, color: s.gcp_running ? '#4da6ff' : '#cbd5e1', fontWeight: 700 }}>{s.gcp_running}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {workers && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Workers left
              </div>
              <table style={{ borderCollapse: 'collapse', minWidth: 360 }}>
                <thead>
                  <tr style={{ background: '#111' }}>
                    <th style={cellTh}>Pool</th>
                    <th style={cellTh}>Used</th>
                    <th style={cellTh}>Capacity</th>
                    <th style={cellTh}>Left</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={cellTd}>AWS (Lab)</td>
                    <td style={cellTd}>{workers.aws.used}</td>
                    <td style={cellTd}>{workers.aws.total}</td>
                    <td style={{ ...cellTd, color: '#22c55e', fontWeight: 600 }}>{workers.aws.left}</td>
                  </tr>
                  <tr>
                    <td style={cellTd}>GCP</td>
                    <td style={cellTd}>{workers.gcp.used}</td>
                    <td style={cellTd}>{workers.gcp.total}</td>
                    <td style={{ ...cellTd, color: '#22c55e', fontWeight: 600 }}>{workers.gcp.left}</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#555', marginTop: 8, lineHeight: 1.5 }}>
                Used counts per-codec worker slots in flight: each episode with{' '}
                <code>lab_h264_status</code> or <code>lab_h265_status</code> in{' '}
                <code>STARTING</code>/<code>RUNNING</code> consumes one AWS slot (so an episode
                running both codecs = 2 slots). GCP counts the same way, plus{' '}
                <code>COMBINING</code> as one slot. Capacity is the fixed pool size{' '}
                (AWS=128, GCP=45).
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShowStatusRow({ show, index, pct, isExpanded, onToggle }) {
  const overviewHref = `/show?selected=${encodeURIComponent(String(show._id))}`;
  return (
    <>
      <tr
        style={{
          background: isExpanded ? 'rgba(77,166,255,0.04)' : index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
          borderBottom: isExpanded ? 'none' : '1px solid #1e1e1e',
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <td style={{ padding: '10px 14px' }}>
          <Link
            href={overviewHref}
            style={{ color: '#e2e8f0', fontWeight: 500 }}
            onClick={(e) => e.stopPropagation()}
          >
            {show.title}
          </Link>
          <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>{show.slug || String(show._id)}</div>
        </td>
        <td style={{ padding: '10px 14px', color: '#cbd5e1', fontSize: 12 }}>
          {langDisplay(show.language || 'unknown')}
        </td>
        <td style={{ padding: '10px 14px', color: '#cbd5e1', fontSize: 12 }}>
          {show.episode_combined}/{show.episode_total}
        </td>
        <td style={{ padding: '10px 14px', minWidth: 140 }}>
          <div style={{
            background: '#0e0e0e',
            border: '1px solid #222',
            borderRadius: 4,
            height: 8,
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              width: `${pct}%`,
              height: '100%',
              background: pct === 100 ? '#22c55e' : pct === 0 ? '#ef4444' : '#f59e0b',
            }} />
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>{pct}%</div>
        </td>
        <td style={{ padding: '10px 14px' }}>
          <StatusPill status={show.status} />
        </td>
        <td style={{ padding: '10px 14px', textAlign: 'center', color: '#555' }}>
          {show.missing_count > 0 ? (
            <span style={{
              display: 'inline-block',
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              color: isExpanded ? '#4da6ff' : '#555',
              fontSize: 11,
              fontWeight: 600,
            }}>▼</span>
          ) : null}
        </td>
      </tr>
      {isExpanded && show.missing_count > 0 && (
        <tr style={{ background: 'rgba(77,166,255,0.04)', borderBottom: '1px solid #2a2a2a' }}>
          <td colSpan={6} style={{ padding: '10px 18px' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
              Missing combined ({show.missing_count} ep
              {show.missing_count !== 1 ? 's' : ''}
              {show.missing_count > show.missing_sample.length
                ? `, showing first ${show.missing_sample.length}`
                : ''}
              ):
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {show.missing_sample.map((ep, i) => (
                <span
                  key={ep.id || i}
                  style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: 4,
                    background: '#111',
                    border: `1px solid ${ep.has_url ? '#f59e0b' : '#444'}`,
                    color: ep.has_url ? '#fbbf24' : '#94a3b8',
                  }}
                  title={ep.has_url ? 'Episode has a non-combined URL' : 'No signed playback URL yet'}
                >
                  Ep {ep.episode_number ?? '?'} · {ep.title || ep.id || '—'}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <Link href={overviewHref} style={{ fontSize: 12, color: '#4da6ff' }}>
                Open in Show overview →
              </Link>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
