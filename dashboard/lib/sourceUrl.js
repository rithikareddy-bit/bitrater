import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Source videos are referenced by a field named `s3_url`, but the value is not
// always an S3 URL — some records (notably anything written by the Sanity dev
// store) point at Azure Blob Storage. The old parser had no "is this S3?" test:
// anything that wasn't a path-style S3 URL fell through to a virtual-hosted
// branch that did `host.split('.s3')[0]`, which on a non-S3 host returns the
// whole hostname. That produced a plausible-looking bucket name, presigned it
// without error (presigning is pure local HMAC — S3 is never contacted), and
// only failed four steps later when ffprobe got NoSuchBucket back. Dispatch on
// the host instead, and hand non-S3 sources to ffprobe directly.

function s3Region(host) {
  // bucket.s3.<region>.amazonaws.com and the legacy bucket.s3-<region>.… form.
  // bucket.s3.amazonaws.com carries no region and must stay undefined so the
  // caller's fallback applies.
  const match = host.match(/\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/);
  return match && match[1] !== 'amazonaws' ? match[1] : undefined;
}

/**
 * Classify a source URL. Returns either
 *   { provider: 's3', bucket, key, region, label }
 *   { provider: 'http', url, label }
 * `label` is a short human-readable identifier for error messages.
 */
export function parseSourceUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('source url is missing');
  }

  const parsed = new URL(url.trim());
  const host = parsed.hostname;
  // S3 keys are stored URL-encoded in some records ("Ep%20-%207"); the S3 API
  // wants the literal key. The http branch below keeps the URL as-is.
  const path = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  // s3://bucket/key (orchestrator/lambda_trigger.py)
  if (parsed.protocol === 's3:') {
    return { provider: 's3', bucket: host, key: path, region: undefined, label: `${host}/${path}` };
  }

  // Path-style: s3.<region>.amazonaws.com/<bucket>/<key>
  if (host.startsWith('s3') && host.endsWith('.amazonaws.com')) {
    const bucket = path.split('/', 1)[0];
    const key = path.slice(bucket.length + 1);
    const segments = host.split('.');
    const region = segments.length >= 4 ? segments[1] : undefined;
    return { provider: 's3', bucket, key, region, label: `${bucket}/${key}` };
  }

  // Virtual-hosted: <bucket>.s3[.<region>].amazonaws.com/<key>
  if (host.endsWith('.amazonaws.com') && host.includes('.s3')) {
    const bucket = host.split('.s3')[0];
    return {
      provider: 's3',
      bucket,
      key: path,
      region: s3Region(host),
      label: `${bucket}/${path}`,
    };
  }

  // Anything else (Azure Blob, a CDN, a plain origin) is fetched directly.
  // ffmpeg's HTTP handler does ranged reads, so it streams headers without
  // pulling the whole file — same behaviour we get from a presigned S3 URL.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported source url protocol: ${parsed.protocol}`);
  }
  return { provider: 'http', url: url.trim(), label: `${host}/${path}` };
}

/**
 * Turn a source URL into something ffprobe/ffmpeg can read: a presigned URL for
 * private S3 objects, the URL itself for everything else.
 */
export async function resolveSourceUrl(sourceUrl, { expiresIn = 120 } = {}) {
  const source = parseSourceUrl(sourceUrl);

  if (source.provider !== 's3') {
    return { url: source.url, label: source.label, provider: source.provider };
  }

  const s3 = new S3Client({
    region: source.region || process.env.AWS_REGION || 'ap-south-2',
  });
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: source.bucket, Key: source.key }),
    { expiresIn },
  );
  return { url, label: source.label, provider: 's3' };
}
