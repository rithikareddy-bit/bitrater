'use client';

/**
 * Audio overview — same layout shape as /show:
 *   ← Catalog                        Audio overview
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Select show              │   Show stats                   │
 *   │  [All] [te] [hi] [kn]    │   total episodes, status mix,  │
 *   │  [search…]               │   ladder summary               │
 *   │  scrollable show list    │                                │
 *   │  [Run pipeline] [Force]  │                                │
 *   └────────────────────────────────────────────────────────────┘
 *   ● Live · refresh every 8s · [Refresh now]
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ SHOW TITLE · N episodes                                              │
 *   ├──────────────────────────────────────────────────────────────────────┤
 *   │ # | Episode | Status | Ladder | Public URL | [Run]                  │
 *   └──────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

const POLL_MS = 8000;

const LANG_LABELS = {
  te: 'Telugu', hi: 'Hindi', kn: 'Kannada', ta: 'Tamil',
  ml: 'Malayalam', en: 'English', bn: 'Bengali', mr: 'Marathi',
  gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu', or: 'Odia', as: 'Assamese',
};
function languageLabel(code) {
  if (!code) return 'Unknown';
  const c = String(code).toLowerCase();
  return LANG_LABELS[c] || c.toUpperCase();
}
function normalizeLang(code) {
  if (code == null) return null;
  const c = String(code).trim().toLowerCase();
  if (!c) return null;
  if (c === 'kan') return 'kn';
  return c;
}

const STATUS_STYLES = {
  SUCCEEDED: { color: '#22c55e', border: '#22c55e', bg: 'rgba(34,197,94,0.08)' },
  RUNNING:   { color: '#f59e0b', border: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  COPYING:   { color: '#4da6ff', border: '#4da6ff', bg: 'rgba(77,166,255,0.08)' },
  FAILED:    { color: '#f87171', border: '#f87171', bg: 'rgba(248,113,113,0.08)' },
  idle:      { color: '#666',    border: '#444',    bg: 'transparent' },
};

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: 'server returned an invalid response' }; }
}

function LangPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${active ? '#4da6ff' : '#333'}`,
        background: active ? '#1c2c44' : '#111',
        color: active ? '#bfdbfe' : '#aaa',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.idle;
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 78,
        textAlign: 'center',
        fontSize: 11,
        fontWeight: 600,
        color: s.color,
        border: `1px solid ${s.border}`,
        background: s.bg,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {status || 'idle'}
    </span>
  );
}

function StatRow({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
      <span style={{ color: '#666', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 110 }}>
        {label}
      </span>
      <span style={{ color: '#e8e8e8', fontSize: 14, fontWeight: 600 }}>{value}</span>
      {sub && <span style={{ color: '#555', fontSize: 11 }}>{sub}</span>}
    </div>
  );
}

function StatsPanel({ data }) {
  const eps = data?.episodes || [];
  const counts = { SUCCEEDED: 0, RUNNING: 0, COPYING: 0, FAILED: 0, idle: 0 };
  let withPublic = 0;
  let publishFailed = 0;
  const ladderSet = new Set();
  for (const e of eps) {
    counts[e.status] = (counts[e.status] || 0) + 1;
    if (e.public) withPublic += 1;
    if (e.publish_error && e.status === 'SUCCEEDED') publishFailed += 1;
    if (Array.isArray(e.ladder)) e.ladder.forEach((k) => ladderSet.add(k));
  }
  const total = eps.length;
  const ladder = [...ladderSet].sort((a, b) => a - b).map((k) => `${k}k`).join('/') || '—';

  return (
    <div>
      <div style={{ color: '#888', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        Show stats
      </div>
      <StatRow label="Total episodes" value={total} />
      <StatRow label="Succeeded" value={counts.SUCCEEDED} sub={total ? `${Math.round((counts.SUCCEEDED / total) * 100)}%` : null} />
      <StatRow label="Running" value={counts.RUNNING + counts.COPYING} sub={counts.COPYING ? `${counts.COPYING} copying` : null} />
      <StatRow label="Failed" value={counts.FAILED} />
      <StatRow label="Not started" value={counts.idle} />
      <StatRow label="Ladder seen" value={ladder} />
      <StatRow label="Public manifests" value={withPublic} sub={total ? `${Math.round((withPublic / total) * 100)}%` : null} />
      {publishFailed > 0 && (
        <StatRow label="Publish failed" value={publishFailed} sub="transcode OK; public copy didn't run" />
      )}
    </div>
  );
}

export default function AudioOverviewPage() {
  // ── catalog state ─────────────────────────────────────────────────
  const [shows, setShows] = useState([]);
  const [showsLoading, setShowsLoading] = useState(true);
  const [showsError, setShowsError] = useState(null);
  const [activeLang, setActiveLang] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [force, setForce] = useState(false);

  // ── per-show live state ───────────────────────────────────────────
  const [live, setLive] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const [epBusy, setEpBusy] = useState({}); // episodeId -> bool

  const timerRef = useRef(null);
  const visibleRef = useRef(true);

  // Load catalog once
  useEffect(() => {
    fetch('/api/audio/episodes')
      .then(safeJson)
      .then((d) => {
        if (d.error) setShowsError(d.error);
        else setShows(Array.isArray(d) ? d : []);
      })
      .catch(() => setShowsError('failed to load podcasts'))
      .finally(() => setShowsLoading(false));
  }, []);

  // Tab-visible flag (skip polling while hidden)
  useEffect(() => {
    const onVis = () => { visibleRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Language counts + filtering
  const { langCounts, presentLangs } = useMemo(() => {
    const counts = {};
    for (const s of shows) {
      const lang = normalizeLang(s.language) || 'unknown';
      counts[lang] = (counts[lang] || 0) + 1;
    }
    const present = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return { langCounts: counts, presentLangs: present };
  }, [shows]);

  const filteredShows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return shows.filter((s) => {
      if (activeLang !== 'all') {
        const lang = normalizeLang(s.language) || 'unknown';
        if (lang !== activeLang) return false;
      }
      if (!q) return true;
      return (
        (s.title || '').toLowerCase().includes(q) ||
        (s.slug || '').toLowerCase().includes(q)
      );
    });
  }, [shows, activeLang, search]);

  // Fetch the per-show episode list
  const loadLive = useCallback(async (slug, quiet) => {
    if (!slug) return;
    if (!quiet) setLiveLoading(true);
    setLiveError(null);
    try {
      const d = await fetch(`/api/audio/episodes?slug=${encodeURIComponent(slug)}`).then(safeJson);
      if (d.error) throw new Error(d.error);
      setLive(d);
      setFetchedAt(Date.now());
    } catch (e) {
      setLiveError(e.message || 'Failed to load episodes');
      if (!quiet) setLive(null);
    } finally {
      if (!quiet) setLiveLoading(false);
    }
  }, []);

  // (Re)load when selection changes
  useEffect(() => {
    if (!selectedSlug) { setLive(null); return; }
    loadLive(selectedSlug, false);
  }, [selectedSlug, loadLive]);

  // Poll while a show is selected
  useEffect(() => {
    if (!selectedSlug) return;
    timerRef.current = setInterval(() => {
      if (!visibleRef.current) return;
      loadLive(selectedSlug, true);
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [selectedSlug, loadLive]);

  async function runShow() {
    if (!selectedSlug) return;
    if (force && !confirm('Force re-run reconverts every episode of this show, including ones already SUCCEEDED. Continue?')) return;
    setRunBusy(true);
    const r = await fetch('/api/audio/run-show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: selectedSlug, force }),
    }).then(safeJson);
    setRunBusy(false);
    if (r.error) alert(`Run failed: ${r.error}`);
    else loadLive(selectedSlug, true);
  }

  async function runEpisode(episodeId) {
    setEpBusy((p) => ({ ...p, [episodeId]: true }));
    const r = await fetch('/api/audio/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId }),
    }).then(safeJson);
    setEpBusy((p) => ({ ...p, [episodeId]: false }));
    if (r.error) alert(`Convert failed: ${r.error}`);
    else loadLive(selectedSlug, true);
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: 24, color: '#e8e8e8', fontFamily: 'system-ui' }}>
      <div style={{ marginBottom: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: '#4da6ff' }}>← Catalog</Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Audio overview</h1>
        <span style={{ color: '#666', fontSize: 12 }}>
          podcast_showcache · HLS-AAC 64/96/128k · −16 LUFS
        </span>
      </div>

      <div
        style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '18px 20px',
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'flex-start' }}>
          {/* ── Left: catalog ───────────────────────────────────── */}
          <div style={{ flex: '1 1 260px', minWidth: 0, maxWidth: 460 }}>
            <label
              htmlFor="audio-show-search"
              style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8 }}
            >
              Select show
            </label>
            {showsLoading && <p style={{ color: '#888', margin: 0 }}>Loading podcasts…</p>}
            {showsError && <p style={{ color: '#f87171', margin: 0 }}>{showsError}</p>}
            {!showsLoading && !showsError && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  <LangPill
                    label={`All (${shows.length})`}
                    active={activeLang === 'all'}
                    onClick={() => setActiveLang('all')}
                  />
                  {presentLangs.map((code) => (
                    <LangPill
                      key={code}
                      label={`${code === 'unknown' ? 'Unknown' : languageLabel(code)} (${langCounts[code]})`}
                      active={activeLang === code}
                      onClick={() => setActiveLang(code)}
                    />
                  ))}
                </div>

                <input
                  id="audio-show-search"
                  type="search"
                  placeholder="Search podcasts…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid #333',
                    background: '#111',
                    color: '#e8e8e8',
                    fontSize: 14,
                    marginBottom: 8,
                  }}
                />

                <div
                  style={{
                    maxHeight: 280,
                    overflowY: 'auto',
                    border: '1px solid #2a2a2a',
                    borderRadius: 8,
                    background: '#0e0e0e',
                  }}
                >
                  {filteredShows.length === 0 && (
                    <div style={{ padding: '12px 14px', color: '#666', fontSize: 12 }}>
                      No podcasts match this filter.
                    </div>
                  )}
                  {filteredShows.map((s) => {
                    const isActive = s.slug === selectedSlug;
                    return (
                      <button
                        key={s.slug}
                        type="button"
                        onClick={() => setSelectedSlug(s.slug)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 12px',
                          background: isActive ? '#1c2c44' : 'transparent',
                          color: isActive ? '#bfdbfe' : '#e8e8e8',
                          border: 'none',
                          borderBottom: '1px solid #1a1a1a',
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontWeight: 500 }}>{s.title || s.slug}</span>
                        <span style={{ color: '#64748b', fontSize: 11, marginLeft: 8 }}>
                          {languageLabel(s.language)} · {s.episode_count} ep
                        </span>
                      </button>
                    );
                  })}
                </div>

                <p style={{ margin: '10px 0 0', fontSize: 11, color: '#555' }}>
                  {filteredShows.length} of {shows.length} podcasts shown.
                </p>
              </>
            )}

            {selectedSlug && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={runShow}
                  disabled={runBusy}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: '1px solid #166534',
                    background: runBusy ? '#0f2a18' : '#166534',
                    color: '#dcfce7',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: runBusy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {runBusy ? 'Starting…' : '▶ Run pipeline'}
                </button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#aaa', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={(e) => setForce(e.target.checked)}
                  />
                  Force (re-run all)
                </label>
              </div>
            )}
          </div>

          {/* ── Right: stats ───────────────────────────────────── */}
          <div className="audio-overview-stats" style={{ flex: '1 1 300px', minWidth: 260 }}>
            {!selectedSlug && (
              <p style={{ color: '#555', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Select a podcast to see <strong style={{ color: '#777' }}>conversion progress</strong>,
                ladder seen, and how many episodes have a public master.
              </p>
            )}
            {selectedSlug && liveLoading && !live && (
              <p style={{ color: '#888', fontSize: 13, margin: 0 }}>Loading show stats…</p>
            )}
            {selectedSlug && liveError && (
              <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>{liveError}</p>
            )}
            {live && <StatsPanel data={live} />}
          </div>
        </div>
      </div>

      {selectedSlug && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12, fontSize: 12, color: '#888' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#4ade80', fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px rgba(74,222,128,0.6)', animation: 'pulse 2s ease-in-out infinite' }} />
            Live
          </span>
          <span>Refresh every {Math.round(POLL_MS / 1000)}s</span>
          {fetchedAt && (
            <span style={{ color: '#555' }}>
              Last update: {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => loadLive(selectedSlug, false)}
            disabled={liveLoading}
            style={{
              marginLeft: 'auto',
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #333',
              background: '#1a1a1a',
              color: '#e8e8e8',
              fontSize: 12,
            }}
          >
            {liveLoading ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.45;} }
        .audio-overview-stats { border-left: 1px solid #2a2a2a; padding-left: 28px; }
        @media (max-width: 720px) {
          .audio-overview-stats { border-left: none; padding-left: 0; border-top: 1px solid #2a2a2a; padding-top: 20px; margin-top: 4px; width: 100%; }
        }
      `}</style>

      {selectedSlug && liveLoading && !live && (
        <p style={{ color: '#888' }}>Loading episodes…</p>
      )}

      {live && (
        <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid #2a2a2a',
            fontSize: 13,
            fontWeight: 600,
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            display: 'flex',
            alignItems: 'center',
          }}>
            {live.title || live.slug}
            <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>
              {live.episodes.length} episode{live.episodes.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#111' }}>
                  {['#', 'Episode', 'Status', 'Ladder', 'Public master', ''].map((h, i) => (
                    <th
                      key={h || `actions-${i}`}
                      style={{
                        textAlign: h === '#' ? 'center' : 'left',
                        padding: '10px 12px',
                        borderBottom: '1px solid #2a2a2a',
                        color: '#888',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        position: 'sticky',
                        top: 0,
                        background: '#111',
                        zIndex: 1,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {live.episodes.map((ep, i) => (
                  <tr
                    key={ep.id || i}
                    style={{
                      borderBottom: '1px solid #1e1e1e',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <td style={{ padding: '10px 12px', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>
                      {ep.episode_number ?? '—'}
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 320 }}>
                      <div style={{ color: '#e2e8f0', fontWeight: 500, lineHeight: 1.35 }}>
                        {ep.title || ep.id}
                      </div>
                      {ep.status === 'FAILED' && ep.error && (
                        <div style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>{ep.error}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        <StatusPill status={ep.status} />
                        {ep.publish_error && ep.status === 'SUCCEEDED' && (
                          <span
                            title={`Public-bucket copy failed: ${ep.publish_error}. Transcode itself succeeded; the gs:// master is valid.`}
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: '#fbbf24',
                              border: '1px solid #fbbf24',
                              background: 'rgba(251,191,36,0.08)',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}
                          >
                            ⚠ publish failed
                          </span>
                        )}
                        {Array.isArray(ep.subtitle_tracks) && ep.subtitle_tracks.length > 0 && (
                          <span
                            title={ep.subtitle_tracks.map((t) => `${t.name} (${t.lang})`).join(', ')}
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: '#34d399',
                              border: '1px solid #34d399',
                              background: 'rgba(52,211,153,0.08)',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}
                          >
                            CC {ep.subtitle_tracks.length}
                          </span>
                        )}
                        {ep.subtitle_publish_error && ep.status === 'SUCCEEDED' && (
                          <span
                            title={`Subtitle publish failed: ${ep.subtitle_publish_error}. Audio master is valid but has no embedded subtitles.`}
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: '#fbbf24',
                              border: '1px solid #fbbf24',
                              background: 'rgba(251,191,36,0.08)',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}
                          >
                            ⚠ subs failed
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#aaa', whiteSpace: 'nowrap' }}>
                      {ep.ladder ? ep.ladder.map((k) => `${k}k`).join(' / ') : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 360 }}>
                      {ep.master_uri ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {ep.public ? (
                            <a
                              href={ep.master_uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#4da6ff', fontSize: 11, wordBreak: 'break-all' }}
                            >
                              Open
                            </a>
                          ) : (
                            <span style={{ color: '#555', fontSize: 11 }}>private (gs://)</span>
                          )}
                          <button
                            onClick={() => navigator.clipboard?.writeText(ep.master_uri)}
                            style={{ padding: '2px 8px', border: '1px solid #333', borderRadius: 4, background: '#1a1a1a', color: '#aaa', fontSize: 11, cursor: 'pointer' }}
                          >
                            Copy
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: '#555' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => runEpisode(ep.id)}
                        disabled={epBusy[ep.id] || ep.status === 'RUNNING' || ep.status === 'COPYING'}
                        title={ep.status === 'SUCCEEDED' ? 'Re-run this episode' : 'Run this episode'}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 5,
                          border: '1px solid #333',
                          background: epBusy[ep.id] ? '#1a1a1a' : '#1a1a1a',
                          color: '#e8e8e8',
                          fontSize: 11,
                          cursor: epBusy[ep.id] || ep.status === 'RUNNING' || ep.status === 'COPYING' ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {epBusy[ep.id] ? 'Starting…' : ep.status === 'SUCCEEDED' ? 'Re-run' : 'Run'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '12px 18px', fontSize: 11, color: '#555', lineHeight: 1.5 }}>
            Status lifecycle: <code style={{ color: '#888' }}>idle → COPYING → RUNNING → SUCCEEDED|FAILED</code>.
            Ladder is the kbps rungs the Transcoder produced. Public master opens the HLS playlist
            directly from <code style={{ color: '#888' }}>chai-q-audio-public</code> in a new tab.
          </div>
        </div>
      )}

      {selectedSlug && !liveLoading && live && live.episodes.length === 0 && (
        <p style={{ color: '#888' }}>This podcast has no episodes with an audio_url.</p>
      )}
    </div>
  );
}
