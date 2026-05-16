import crypto from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';

export const UPLOAD_BUCKET = process.env.UPLOAD_S3_BUCKET || 'sanity-dev-store';
export const UPLOAD_REGION = process.env.UPLOAD_S3_REGION || 'ap-south-2';
export const UPLOAD_PREFIX = (process.env.UPLOAD_S3_PREFIX || 'uploads/episodes/').replace(/^\/+|\/+$/g, '') + '/';
export const PART_SIZE = (parseInt(process.env.UPLOAD_PART_SIZE_MIB || '16', 10) || 16) * 1024 * 1024;
export const PRESIGN_TTL = 15 * 60;

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
};
export function contentTypeFor(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

let _s3;
export function getS3() {
  if (_s3) return _s3;
  _s3 = new S3Client({
    region: UPLOAD_REGION,
    // Disable the SDK's default flexible checksum so the presigned PUT
    // signature does not require an x-amz-checksum-* header the browser
    // never sends. See G2 in UPLOAD-VIDEOS-PLAN.md.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return _s3;
}

const TOKEN_SECRET = process.env.UPLOAD_TOKEN_SECRET
  || process.env.MONGO_URI
  || 'dev-only-fallback-secret-please-set-UPLOAD_TOKEN_SECRET';

export function signUploadToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyUploadToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function sanitizeSlug(slug) {
  return String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function sanitizeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

export function buildEpisodeKey({ slug, episodeNumber, fileName }) {
  const safeSlug = sanitizeSlug(slug);
  const epPad = String(episodeNumber).padStart(3, '0');
  const ts = Date.now();
  const safeName = sanitizeFileName(fileName);
  return `${UPLOAD_PREFIX}${safeSlug}/ep-${epPad}/${ts}-${safeName}`;
}

export function publicS3Url(key) {
  return `https://s3.${UPLOAD_REGION}.amazonaws.com/${UPLOAD_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
