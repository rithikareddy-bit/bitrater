/**
 * Derive video_id from S3 (or any) URL filename without extension.
 * Matches Python: url.rstrip("/").split("/")[-1].rsplit(".", 1)[0]
 */
export function videoIdFromS3Url(s3Url) {
  if (!s3Url || typeof s3Url !== 'string') return '';
  const base = s3Url.trim().replace(/\/$/, '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}
