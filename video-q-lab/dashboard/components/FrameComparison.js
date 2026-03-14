'use client';

import { useState } from 'react';

export default function FrameComparison({ episodeId, golden, videoUrl }) {
  const [zoomed, setZoomed] = useState(false);

  const sourceUrl = videoUrl || golden?.s3_url || null;

  const panelStyle = {
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    height: 480,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    cursor: 'zoom-in',
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
        Portrait video preview — click panels to zoom (2×)
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
      }}>
        {/* Source panel */}
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4, textAlign: 'center' }}>
            SOURCE
          </div>
          <div onClick={() => setZoomed(!zoomed)} style={panelStyle}>
            {sourceUrl ? (
              <video
                src={sourceUrl}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  transform: zoomed ? 'scale(2)' : 'scale(1)',
                  transition: 'transform 0.25s',
                }}
                muted
                loop
                autoPlay
                playsInline
              />
            ) : (
              <span style={{ color: '#444', fontSize: 12 }}>No source URL</span>
            )}
          </div>
        </div>

        {/* Encoded variant panel */}
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4, textAlign: 'center' }}>
            GOLDEN ENCODE
          </div>
          <div onClick={() => setZoomed(!zoomed)} style={panelStyle}>
            <span style={{ color: '#444', fontSize: 12, textAlign: 'center', padding: 16 }}>
              {golden
                ? 'Encoded variant stored in S3 after lab run'
                : 'Run lab first to generate golden encode'}
            </span>
          </div>
        </div>
      </div>

      {zoomed && (
        <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8, textAlign: 'center' }}>
          2× zoom active — click again to reset
        </div>
      )}
    </div>
  );
}
