'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { uploadFile } from '@/lib/multipartUploader';

export default function UploadVideosPage() {
  const [shows, setShows] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/uploads/shows`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setShows(data.shows || []);
      })
      .catch(() => setError('failed to load shows'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) =>
      (s.title || '').toLowerCase().includes(q) || (s.slug || '').toLowerCase().includes(q)
    );
  }, [shows, query]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Upload Videos</h1>
        <span style={{ color: '#888', fontSize: 13 }}>
          Episodes are read from <strong>prod</strong>. Upload → S3, then click Sync to write the URL to <strong>prod</strong> and <strong>dev</strong>.
        </span>
      </div>

      <input
        placeholder="Search shows by title or slug..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 6,
          background: '#111', color: '#eee', border: '1px solid #333', marginBottom: 16,
        }}
      />

      {loading && <p style={{ color: '#888' }}>Loading...</p>}
      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map((s) => (
          <ShowRow
            key={s._id}
            show={s}
            expanded={expanded === s._id}
            onToggle={() => setExpanded(expanded === s._id ? null : s._id)}
          />
        ))}
      </div>
    </div>
  );
}

function ShowRow({ show, expanded, onToggle }) {
  return (
    <div style={{ border: '1px solid #333', borderRadius: 8, background: '#0d0d0d' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', padding: '10px 14px', textAlign: 'left',
          background: 'transparent', border: 'none', color: '#eee',
          display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1 }}>
          <strong>{show.title || show.slug}</strong>
          <span style={{ color: '#888', marginLeft: 8, fontSize: 13 }}>
            /{show.slug} • {show.episodeCount || 0} eps
          </span>
        </span>
        <span style={{ color: '#888' }}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <EpisodeList slug={show.slug} />}
    </div>
  );
}

function EpisodeList({ slug }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    fetch(`/api/uploads/episodes?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { if (d.error) setErr(d.error); else setData(d); } })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [slug, reloadTick]);

  if (err) return <div style={{ padding: 12, color: '#f87171' }}>{err}</div>;
  if (!data) return <div style={{ padding: 12, color: '#888' }}>Loading episodes...</div>;
  if (!data.episodes.length) return <div style={{ padding: 12, color: '#888' }}>No episodes.</div>;

  return (
    <div style={{ borderTop: '1px solid #222' }}>
      {data.episodes.map((ep) => (
        <EpisodeRow
          key={`${slug}-${ep.episode_number}`}
          slug={slug}
          episode={ep}
          onSynced={() => setReloadTick((t) => t + 1)}
        />
      ))}
    </div>
  );
}

function EpisodeRow({ slug, episode, onSynced }) {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('idle'); // idle | uploading | uploaded | syncing | synced | error
  const [uploadedUrl, setUploadedUrl] = useState(null);
  const [uploadToken, setUploadToken] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [devNote, setDevNote] = useState(null);
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const abortRef = useRef(null);

  const hasExisting = !!episode.s3_url;
  const canUpload = file && (phase === 'idle' || phase === 'error');
  const canSync = phase === 'uploaded' && (!hasExisting || allowOverwrite);

  function resetRow() {
    setProgress(0);
    setUploadedUrl(null);
    setUploadToken(null);
    setErrorMsg(null);
    setDevNote(null);
    setPhase('idle');
  }

  async function handleUpload() {
    if (!file) return;
    setPhase('uploading');
    setProgress(0);
    setErrorMsg(null);
    setDevNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await uploadFile({
        file, slug,
        episodeNumber: episode.episode_number,
        onProgress: (frac) => setProgress(frac),
        signal: ctrl.signal,
      });
      setUploadedUrl(res.url);
      setUploadToken(res.uploadToken);
      setPhase('uploaded');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e.message || 'upload failed');
    } finally {
      abortRef.current = null;
    }
  }

  async function handleSync() {
    if (!uploadToken) return;
    if (hasExisting && !window.confirm(`Replace existing s3_url for ${slug} ep ${episode.episode_number}? Prod will be overwritten.`)) return;
    setPhase('syncing');
    setErrorMsg(null);
    setDevNote(null);
    try {
      const r = await fetch('/api/uploads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadToken, overwrite: hasExisting && allowOverwrite }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Stay in 'uploaded' so Sync/Discard remain available for retry.
        setPhase('uploaded');
        setErrorMsg(data.error || `sync ${r.status}`);
        return;
      }
      setPhase('synced');
      if (data.dev?.attempted && data.dev.ok) setDevNote('dev sync: ok');
      else if (data.dev?.attempted && !data.dev.ok) setDevNote(`dev sync skipped: ${data.dev.reason}`);
      else if (data.dev && !data.dev.attempted) setDevNote(`dev sync not attempted: ${data.dev.reason || 'unknown'}`);
      onSynced?.();
    } catch (e) {
      setPhase('uploaded');
      setErrorMsg(e.message || 'sync failed');
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div style={{
      padding: '10px 14px', borderBottom: '1px solid #1a1a1a',
      display: 'grid', gridTemplateColumns: '60px 1fr auto', gap: 12, alignItems: 'center',
    }}>
      <div style={{ color: '#888', fontSize: 13 }}>EP {episode.episode_number}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {episode.title || '(untitled)'}
        </div>
        {episode.s3_url && (
          <div style={{ fontSize: 11, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            current: <a href={episode.s3_url} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>{episode.s3_url}</a>
          </div>
        )}
        {phase === 'uploading' && (
          <div style={{ marginTop: 6, background: '#222', height: 6, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ background: '#3b82f6', height: '100%', width: `${(progress * 100).toFixed(1)}%`, transition: 'width 120ms linear' }} />
          </div>
        )}
        {uploadedUrl && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#34d399', wordBreak: 'break-all' }}>
            uploaded: <a href={uploadedUrl} target="_blank" rel="noreferrer" style={{ color: '#34d399' }}>{uploadedUrl}</a>
          </div>
        )}
        {phase === 'synced' && (
          <div style={{ marginTop: 3, fontSize: 11, color: '#34d399' }}>✓ synced to prod</div>
        )}
        {devNote && (
          <div style={{ marginTop: 3, fontSize: 11, color: '#a3a3a3' }}>{devNote}</div>
        )}
        {errorMsg && (
          <div style={{ marginTop: 3, fontSize: 11, color: '#f87171', wordBreak: 'break-all' }}>{errorMsg}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {(phase === 'idle' || phase === 'error') && (
          <>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setPhase('idle'); setErrorMsg(null); }}
              style={{ color: '#aaa', fontSize: 12, maxWidth: 200 }}
            />
            <button disabled={!canUpload} onClick={handleUpload} style={btnStyle(canUpload ? '#1e3a8a' : '#222')}>
              Upload
            </button>
          </>
        )}
        {phase === 'uploading' && (
          <button onClick={handleCancel} style={btnStyle('#7f1d1d')}>Cancel</button>
        )}
        {phase === 'uploaded' && (
          <>
            {hasExisting && (
              <label style={{ fontSize: 11, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={allowOverwrite} onChange={(e) => setAllowOverwrite(e.target.checked)} />
                replace
              </label>
            )}
            <button disabled={!canSync} onClick={handleSync} style={btnStyle(canSync ? '#1e3a8a' : '#222')}>
              Sync
            </button>
            <button onClick={resetRow} style={btnStyle('#333')}>Discard</button>
          </>
        )}
        {phase === 'syncing' && (
          <button disabled style={btnStyle('#222')}>Syncing...</button>
        )}
        {phase === 'synced' && (
          <button onClick={resetRow} style={btnStyle('#1e3a8a')}>Done</button>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg) {
  return {
    padding: '6px 12px', borderRadius: 6, border: 'none',
    background: bg, color: '#fff', cursor: 'pointer', fontSize: 12,
  };
}
