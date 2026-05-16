// Browser-side S3 multipart uploader. Streams the file directly to S3
// using presigned URLs minted by /api/uploads/sign-part. Reports progress
// via the onProgress callback. See UPLOAD-VIDEOS-PLAN.md for the full flow.

const PARALLELISM = 4;
const MAX_RETRIES = 3;

function putPart(url, blob, onChunk, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onChunk(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) reject(new Error('S3 did not return ETag — check bucket CORS ExposeHeaders'));
        else resolve(etag);
      } else {
        reject(new Error(`PUT part failed: ${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during PUT'));
    xhr.onabort = () => reject(new Error('aborted'));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

export async function uploadFile({ file, slug, episodeNumber, overwrite, onProgress, signal }) {
  // 1. init
  const initRes = await fetch('/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug, episodeNumber, overwrite: !!overwrite,
      fileName: file.name, fileSize: file.size,
    }),
    signal,
  });
  if (!initRes.ok) throw new Error((await initRes.json()).error || `init ${initRes.status}`);
  const { uploadToken, key, partSize, existingS3Url } = await initRes.json();

  // beforeunload → best-effort abort beacon so the multipart isn't orphaned.
  const beaconHandler = () => {
    try {
      const blob = new Blob([JSON.stringify({ uploadToken })], { type: 'application/json' });
      navigator.sendBeacon('/api/uploads/abort', blob);
    } catch {}
  };
  window.addEventListener('beforeunload', beaconHandler);

  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  if (totalParts > 10000) throw new Error(`File too large for current partSize (${totalParts} parts > 10000)`);
  const partProgress = new Array(totalParts).fill(0);
  const reportProgress = () => {
    const sent = partProgress.reduce((a, b) => a + b, 0);
    onProgress?.(Math.min(1, sent / file.size), { sent, total: file.size });
  };

  const parts = new Array(totalParts);

  async function sendOnePart(idx) {
    const partNumber = idx + 1;
    const start = idx * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        const signRes = await fetch('/api/uploads/sign-part', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadToken, partNumber }),
          signal,
        });
        if (!signRes.ok) throw new Error((await signRes.json()).error || `sign ${signRes.status}`);
        const { url } = await signRes.json();
        partProgress[idx] = 0;
        reportProgress();
        const etag = await putPart(url, blob, (loaded) => {
          partProgress[idx] = loaded;
          reportProgress();
        }, signal);
        parts[idx] = { PartNumber: partNumber, ETag: etag };
        partProgress[idx] = blob.size;
        reportProgress();
        return;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted || e.message === 'aborted') throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('part failed');
  }

  // pool of workers
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLELISM, totalParts) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= totalParts) return;
      await sendOnePart(idx);
    }
  });
  try {
    await Promise.all(workers);
  } catch (e) {
    window.removeEventListener('beforeunload', beaconHandler);
    try {
      await fetch('/api/uploads/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadToken }),
      });
    } catch {}
    throw e;
  }

  // 3. complete
  let compRes;
  try {
    compRes = await fetch('/api/uploads/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadToken, parts, overwrite: !!overwrite }),
    });
  } finally {
    window.removeEventListener('beforeunload', beaconHandler);
  }
  if (!compRes.ok) throw new Error((await compRes.json()).error || `complete ${compRes.status}`);
  const result = await compRes.json();
  return { ...result, key, existingS3Url, uploadToken };
}

export function buildAbortBeacon(uploadToken) {
  return new Blob([JSON.stringify({ uploadToken })], { type: 'application/json' });
}
