'use client';

import { useState } from 'react';

export default function SourceProbe({ episodeId }) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleProbe = async () => {
    setProbing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/probe-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Probe failed');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setProbing(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleProbe}
        disabled={probing}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: probing ? '#1e1e1e' : '#0f766e',
          color: probing ? '#555' : '#fff',
          border: 'none', borderRadius: 8, padding: '10px 20px',
          fontSize: 14, fontWeight: 600,
          cursor: probing ? 'not-allowed' : 'pointer',
          transition: 'background 0.2s', width: '100%', justifyContent: 'center',
        }}
      >
        {probing ? <><Spinner /> Probing…</> : 'Calculate FPS & Resolution'}
      </button>

      {error && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{
          marginTop: 10, padding: '10px 14px',
          background: '#0a0a0a', border: `1px solid ${result.supported ? '#22c55e' : '#f59e0b'}`,
          borderRadius: 6, fontSize: 13,
        }}>
          <div style={{ display: 'flex', gap: 20, marginBottom: 6 }}>
            <div>
              <span style={{ color: '#888' }}>Resolution: </span>
              <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{result.width} x {result.height}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>FPS: </span>
              <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{result.fps}</span>
              <span style={{ color: '#555', marginLeft: 4 }}>({result.fps_raw})</span>
            </div>
          </div>
          <div style={{
            fontSize: 12,
            color: result.supported ? '#22c55e' : '#f59e0b',
            fontWeight: 600,
          }}>
            {result.supported
              ? `FPS ${result.fps} is supported`
              : `FPS ${result.fps} is not supported — only 24 and 30 are allowed`}
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid #555', borderTop: '2px solid #0f766e',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
