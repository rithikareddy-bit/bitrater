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
  const [statusFilter, setStatusFilter] = useState('all'); // all | partial | none | full | empty | no_url
  const [activeOnly, setActiveOnly] = useState(true); // default on: show only active shows (mongo active === true)
  const [expandedId, setExpandedId] = useState(null);
  const [activeRuns, setActiveRuns] = useState(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [activeError, setActiveError] = useState(null);
  const [activeOpen, setActiveOpen] = useState(false);
  const [vtt, setVtt] = useState(null);
  const [vttLoading, setVttLoading] = useState(false);
  const [vttError, setVttError] = useState(null);
  const [vttOpen, setVttOpen] = useState(false);

  const checkVtts = () => {
    setVttOpen(true);
    setVttLoading(true);
    setVttError(null);
    fetch('/api/show-status/vtt-check')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setVtt(d);
      })
      .catch((e) => setVttError(e.message || 'Failed to run VTT check'))
      .finally(() => setVttLoading(false));
  };

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

  // When "Active only" is on, everything below — summary cards, table, and the
  // shows counter — is scoped to shows with active === true.
  const scopedShows = activeOnly ? shows.filter((s) => s.active) : shows;

  const summary = data
    ? scopedShows.reduce(
        (acc, s) => {
          acc[s.status] = (acc[s.status] || 0) + 1;
          acc.total_shows += 1;
          acc.total_episodes += s.episode_total || 0;
          acc.total_combined_episodes += s.episode_combined || 0;
          return acc;
        },
        { full: 0, partial: 0, none: 0, empty: 0, total_shows: 0, total_episodes: 0, total_combined_episodes: 0 },
      )
    : null;

  const filteredShows = scopedShows.filter((s) => {
    if (statusFilter === 'no_url') return (s.no_url_count || 0) > 0;
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
        <button
          type="button"
          onClick={checkVtts}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid #a78bfa',
            background: '#241c44',
            color: '#ddd6fe',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Check VTTs
        </button>
      </div>

      {vttOpen && (
        <VttCheckPanel
          data={vtt}
          loading={vttLoading}
          error={vttError}
          onClose={() => setVttOpen(false)}
          onRefresh={checkVtts}
        />
      )}

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
              {['all', 'partial', 'none', 'full', 'empty', 'no_url'].map((s) => (
                <LangPill
                  key={s}
                  label={s === 'all' ? 'All status' : s === 'no_url' ? 'No URL' : (STATUS_STYLE[s]?.label || s)}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setActiveOnly((v) => !v)}
              title={activeOnly ? 'Showing only active shows (active = true)' : 'Showing all shows'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 10px',
                borderRadius: 999,
                border: `1px solid ${activeOnly ? '#4da6ff' : '#333'}`,
                background: activeOnly ? '#1c2c44' : '#111',
                color: activeOnly ? '#bfdbfe' : '#aaa',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 16,
                  borderRadius: 999,
                  background: activeOnly ? '#4da6ff' : '#333',
                  position: 'relative',
                  transition: 'background 0.15s',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: activeOnly ? 16 : 2,
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.15s',
                  }}
                />
              </span>
              Active only
            </button>
            <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 12 }}>
              {filteredShows.length} of {scopedShows.length} shows
              {activeOnly ? ' (active)' : ''}
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

function VttCheckPanel({ data, loading, error, onClose, onRefresh }) {
  const shows = data?.shows || [];
  const [syncing, setSyncing] = useState(null); // null | 'all' | slug
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);

  const runSync = (slug, label) => {
    const count = slug
      ? shows.find((s) => s.slug === slug)?.unsynced_count ?? 0
      : data?.unsynced_episodes ?? 0;
    if (!window.confirm(
      `Write vtt_url into showcache for ${count} episode(s) of ${label}?\n\n`
      + 'This modifies the production database. Existing vtt_url values are never overwritten.',
    )) return;

    setSyncing(slug || 'all');
    setSyncError(null);
    setSyncResult(null);
    fetch('/api/show-status/vtt-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slug ? { slug, confirm: true } : { confirm: true }),
    })
      .then((r) => r.json().then((d) => {
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      }))
      .then((d) => {
        setSyncResult({ ...d, label });
        onRefresh(); // re-run the check so the panel reflects the new state
      })
      .catch((e) => setSyncError(e.message || 'Sync failed'))
      .finally(() => setSyncing(null));
  };

  const btn = {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #333',
    background: '#111',
    color: '#aaa',
    fontSize: 12,
    cursor: 'pointer',
  };

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
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>VTT check — active shows</div>
        <span style={{ color: '#666', fontSize: 12 }}>
          {data
            ? `${data.shows_with_missing} of ${data.active_shows} show(s) · ${data.missing_episodes}/${data.total_episodes} episodes missing`
            : ''}
        </span>
        {data && data.missing_episodes > 0 && (
          <>
            <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600 }}>
              {data.unsynced_episodes} not synced
            </span>
            <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
              {data.no_vtt_episodes} no VTT
            </span>
            {data.no_source_episodes > 0 && (
              <span style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600 }}>
                {data.no_source_episodes} no source
              </span>
            )}
          </>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {data && data.unsynced_episodes > 0 && (
            <button
              type="button"
              disabled={syncing !== null}
              onClick={() => runSync(null, 'all active shows')}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid #f59e0b',
                background: syncing ? '#1a1a1a' : '#2a2110',
                color: syncing ? '#666' : '#fbbf24',
                fontSize: 12,
                fontWeight: 600,
                cursor: syncing ? 'default' : 'pointer',
              }}
            >
              {syncing === 'all' ? 'Syncing…' : `Sync all ${data.unsynced_episodes}`}
            </button>
          )}
          <button type="button" onClick={onRefresh} style={btn}>Refresh</button>
          <button type="button" onClick={onClose} style={btn}>Close</button>
        </div>
      </div>

      {syncError && <p style={{ color: '#f87171', fontSize: 13 }}>Sync failed: {syncError}</p>}
      {syncResult && (
        <div
          style={{
            border: '1px solid #22c55e',
            background: 'rgba(34,197,94,0.08)',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: 12,
            color: '#86efac',
          }}
        >
          Synced {syncResult.synced} episode(s) for {syncResult.label} — showcache updated:{' '}
          {syncResult.showcache_updated}, episode docs updated: {syncResult.episode_updated}.
          {syncResult.no_vtt_available > 0 && (
            <span style={{ color: '#fca5a5' }}>
              {' '}{syncResult.no_vtt_available} episode(s) had no VTT to sync — those need generation.
            </span>
          )}
        </div>
      )}

      {loading && <p style={{ color: '#888', fontSize: 13 }}>Checking vtt_url for every active show…</p>}
      {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}

      {!loading && !error && data && shows.length === 0 && (
        <p style={{ color: '#22c55e', fontSize: 13 }}>
          All {data.total_episodes} episode(s) across {data.active_shows} active show(s) have a vtt_url.
        </p>
      )}

      {!loading && !error && shows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shows.map((s) => (
            <div
              key={String(s._id)}
              style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: '10px 12px', background: '#111' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <Link
                  href={`/show?selected=${encodeURIComponent(String(s._id))}`}
                  style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 13 }}
                >
                  {s.title}
                </Link>
                <span style={{ color: '#555', fontSize: 11 }}>{s.slug || String(s._id)}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {s.missing_count}/{s.episode_total} missing
                  {s.unsynced_count > 0 && <span style={{ color: '#f59e0b' }}> · {s.unsynced_count} not synced</span>}
                  {s.no_vtt_count > 0 && <span style={{ color: '#ef4444' }}> · {s.no_vtt_count} no VTT</span>}
                  {s.no_source_count > 0 && <span style={{ color: '#94a3b8' }}> · {s.no_source_count} no source</span>}
                </span>
                {s.unsynced_count > 0 && (
                  <button
                    type="button"
                    disabled={syncing !== null}
                    onClick={() => runSync(s.slug || s.title, s.title)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 6,
                      border: '1px solid #f59e0b',
                      background: syncing ? '#1a1a1a' : '#2a2110',
                      color: syncing ? '#666' : '#fbbf24',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: syncing ? 'default' : 'pointer',
                    }}
                  >
                    {syncing === (s.slug || s.title) ? 'Syncing…' : `Sync ${s.unsynced_count}`}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {s.missing.map((ep, i) => {
                  const unsynced = ep.state === 'unsynced';
                  const noSource = ep.state === 'no_source';
                  const tone = unsynced
                    ? { border: '#f59e0b', color: '#fbbf24' }
                    : noSource
                      ? { border: '#475569', color: '#94a3b8' }
                      : { border: '#ef4444', color: '#fca5a5' };
                  return (
                    <span
                      key={ep.id || i}
                      style={{
                        fontSize: 11,
                        padding: '3px 8px',
                        borderRadius: 4,
                        background: '#0e0e0e',
                        border: `1px solid ${tone.border}`,
                        color: tone.color,
                      }}
                      title={
                        unsynced
                          ? `VTT exists in episode_vtt but not written to showcache — ${ep.id || ''}`
                          : noSource
                            ? `Episode has no s3_url — no source video to build a VTT from — ${ep.id || ''}`
                            : `No VTT generated yet — ${ep.id || ''}`
                      }
                    >
                      Ep {ep.episode_number ?? '?'} · {ep.title || ep.id || '—'}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#555', marginTop: 12, lineHeight: 1.5 }}>
        Checks <code>master.showcache.episodes[].vtt_url</code> for every show with{' '}
        <code>active: true</code>.{' '}
        <span style={{ color: '#fbbf24' }}>Amber = not synced</span>: a VTT exists in{' '}
        <code>master.episode_vtt</code> but was never written back to showcache (no
        regeneration needed).{' '}
        <span style={{ color: '#fca5a5' }}>Red = no VTT</span>: source exists, nothing
        generated yet — run the worker.{' '}
        <span style={{ color: '#94a3b8' }}>Grey = no source</span>: the episode has no{' '}
        <code>s3_url</code>, so there is no video to build a VTT from — an ingest problem,
        not a VTT one. Matching uses <code>episode_id</code> first, then the source-file
        name, so re-ingested episodes (new id, same file) are still found.
      </div>
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
