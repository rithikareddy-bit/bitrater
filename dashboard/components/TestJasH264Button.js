'use client';

import { useEffect, useState } from 'react';

const STORE_KEY = (epId) => `test-jas-urls:${epId}`;

function loadStoredUrls(epId) {
  try {
    const raw = localStorage.getItem(STORE_KEY(epId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function appendStoredUrl(epId, entry) {
  const list = loadStoredUrls(epId);
  list.unshift(entry);
  try { localStorage.setItem(STORE_KEY(epId), JSON.stringify(list)); } catch {}
  return list;
}

// Variant: "compact" for the episode row in the catalog, "panel" for the
// episode detail page.
export default function TestJasH264Button({ episodeId, variant = 'compact' }) {
  const [state, setState] = useState({ status: 'idle', error: null });
  const [urls, setUrls] = useState([]);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setUrls(loadStoredUrls(episodeId));
    let cancelled = false;
    fetch('/api/test-jas-h264')
      .then((r) => r.ok ? r.json() : { enabled: false })
      .then((body) => { if (!cancelled) setEnabled(body.enabled === true); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, [episodeId]);

  if (!enabled) return null;

  async function trigger(e) {
    e?.stopPropagation?.();
    setState({ status: 'loading', error: null });
    try {
      const r = await fetch('/api/test-jas-h264', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId }),
      });
      const data = await r.json();
      if (!r.ok) {
        setState({ status: 'error', error: data.error || `HTTP ${r.status}` });
        return;
      }
      const next = appendStoredUrl(episodeId, { url: data.gcsUrl, at: new Date().toISOString() });
      setUrls(next);
      setState({ status: 'done', error: null });
    } catch (err) {
      setState({ status: 'error', error: err.message });
    }
  }

  const isPanel = variant === 'panel';
  const btnStyle = isPanel
    ? { padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600 }
    : { padding: '4px 10px', borderRadius: 4, fontSize: 11 };
  const linkFontSize = isPanel ? 11 : 10;

  return (
    <div
      style={isPanel ? undefined : { padding: '6px 0 8px' }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={trigger}
        disabled={state.status === 'loading'}
        style={{
          ...btnStyle,
          border: '1px solid #4da6ff',
          background: state.status === 'loading' ? '#1a2333' : '#2563eb',
          color: '#fff',
          cursor: state.status === 'loading' ? 'wait' : 'pointer',
        }}
      >
        {state.status === 'loading' ? 'Staging + transcoding…' : 'Trigger H264 → GCS URL'}
      </button>
      {state.error && (
        <div style={{ marginTop: 6, fontSize: linkFontSize, color: '#f87171' }}>{state.error}</div>
      )}
      {urls.length > 0 && (
        <div style={{ marginTop: isPanel ? 12 : 6 }}>
          {isPanel && (
            <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 6 }}>
              Previous URLs (newest first):
            </div>
          )}
          {urls.map((u, i) => (
            <div key={i} style={{ marginTop: 4, fontSize: linkFontSize, wordBreak: 'break-all' }}>
              <span style={{ color: '#666', marginRight: 6 }}>{new Date(u.at).toLocaleString()}:</span>
              <a href={u.url} target="_blank" rel="noreferrer" style={{ color: '#22c55e' }}>{u.url}</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
