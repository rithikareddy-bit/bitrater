import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execFile } from 'child_process';
import { promisify } from 'util';
import clientPromise from '@/lib/mongodb';

const execFileAsync = promisify(execFile);

export const TRAILER_LADDER = {
  h264: { '1080p': 3500, '720p': 1200, '480p': 500 },
  h265: { '1080p': 2500, '720p': 900, '480p': 250 },
};

const COMBINED_SUFFIX = '_combined.m3u8';

export function isCombinedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const [path] = url.split('?', 1);
  return path.endsWith(COMBINED_SUFFIX);
}

function parseS3Url(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/^\//, '');

  if (host.startsWith('s3') && host.endsWith('.amazonaws.com')) {
    const parts = path.split('/', 1);
    const bucket = parts[0];
    const key = path.slice(bucket.length + 1);
    const segments = host.split('.');
    const region = segments.length >= 4 ? segments[1] : undefined;
    return { bucket, key, region };
  }

  const bucket = host.split('.s3')[0];
  const key = path;
  const match = host.match(/\.s3\.([^.]+)\./);
  const region = match ? match[1] : undefined;
  return { bucket, key, region };
}

export async function probeTrailerFps(s3Url) {
  const { bucket, key, region } = parseS3Url(s3Url);
  const s3 = new S3Client({ region: region || process.env.AWS_REGION || 'ap-south-2' });
  // URL must outlive the ffprobe timeout below — otherwise a slow probe retries
  // against an already-expired URL and fails with 403.
  const presigned = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );

  let stdout;
  try {
    const result = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate',
        '-of', 'json',
        presigned,
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    // Default err.message is just "Command failed: ffprobe ..." — preserve
    // signal/exit-code/stderr so the scanner can persist a diagnosable reason.
    const stderr = String(err?.stderr || '').trim().slice(0, 400);
    const parts = [
      err?.killed ? 'killed=true' : null,
      err?.signal ? `signal=${err.signal}` : null,
      Number.isInteger(err?.code) ? `exit=${err.code}` : null,
      stderr ? `stderr=${stderr}` : null,
    ].filter(Boolean);
    const suffix = parts.length ? ` (${parts.join(' · ')})` : '';
    const wrapped = new Error(`ffprobe failed for ${bucket}/${key}${suffix}`);
    wrapped.cause = err;
    throw wrapped;
  }

  const data = JSON.parse(stdout);
  const stream = (data.streams || [])[0] || {};
  const fpsRaw = stream.r_frame_rate || null;

  let fpsExact = null;
  if (fpsRaw && fpsRaw.includes('/')) {
    const [num, den] = fpsRaw.split('/').map(Number);
    fpsExact = den ? num / den : null;
  } else if (fpsRaw) {
    fpsExact = Number(fpsRaw);
  }

  if (!fpsExact || !Number.isFinite(fpsExact) || fpsExact <= 0) {
    throw new Error(`ffprobe returned invalid fps: ${fpsRaw}`);
  }

  return Math.round(fpsExact * 10000) / 10000;
}

function buildGoldenRecipes() {
  const resolutions = {};
  for (const res of ['1080p', '720p', '480p']) {
    resolutions[res] = {
      h264: { bitrate_kbps: TRAILER_LADDER.h264[res], pass: true, vmaf_attained: null },
      h265: { bitrate_kbps: TRAILER_LADDER.h265[res], pass: true, vmaf_attained: null },
    };
  }
  return { resolutions };
}

async function readTrailerLabState(episodeId) {
  const client = await clientPromise();
  const labDb = client.db('chai_q_lab');
  return labDb.collection('video_episodes').findOne(
    { episode_id: episodeId },
    {
      projection: {
        source_fps: 1,
        lab_trailer_prepared_s3_url: 1,
        golden_recipes: 1,
        lab_status_h264: 1,
        lab_status_h265: 1,
      },
    },
  );
}

export async function writeTrailerLabState({ episodeId, sourceFps, s3Url }) {
  const client = await clientPromise();
  const labDb = client.db('chai_q_lab');
  const goldenRecipes = buildGoldenRecipes();
  const nowIso = new Date().toISOString();

  await labDb.collection('video_episodes').updateOne(
    { episode_id: episodeId },
    {
      $set: {
        episode_id: episodeId,
        source_fps: sourceFps,
        golden_recipes: goldenRecipes,
        lab_status_h264: 'COMPLETE',
        lab_status_h265: 'COMPLETE',
        lab_trailer_synthetic: true,
        lab_trailer_prepared_at: nowIso,
        lab_trailer_prepared_s3_url: s3Url,
      },
      $unset: {
        lab_error_h264: '',
        lab_error_h265: '',
        search_progress_h264: '',
        search_progress_h265: '',
      },
    },
    { upsert: true },
  );
}

/**
 * Idempotent trailer prep. Skips the ffprobe when the lab already has
 * source_fps + synthetic golden_recipes for this same s3Url. A drifted
 * s3Url (source file replaced) forces a re-probe so downstream encoding
 * reflects the new source.
 *
 * Returns { sourceFps, driftDetected, freshlyProbed }.
 */
export async function prepareTrailer({ episodeId, s3Url }) {
  const existing = await readTrailerLabState(episodeId);
  const s3UrlMatches = existing?.lab_trailer_prepared_s3_url === s3Url;
  const hasFps = Number.isFinite(existing?.source_fps) && existing.source_fps > 0;
  const hasGolden = Boolean(existing?.golden_recipes?.resolutions);

  if (s3UrlMatches && hasFps && hasGolden) {
    // Cache hit — ensure lab_status is COMPLETE but don't touch source_fps/golden.
    if (existing.lab_status_h264 !== 'COMPLETE' || existing.lab_status_h265 !== 'COMPLETE') {
      const client = await clientPromise();
      const labDb = client.db('chai_q_lab');
      await labDb.collection('video_episodes').updateOne(
        { episode_id: episodeId },
        { $set: { lab_status_h264: 'COMPLETE', lab_status_h265: 'COMPLETE' } },
      );
    }
    return { sourceFps: existing.source_fps, driftDetected: false, freshlyProbed: false };
  }

  const driftDetected = Boolean(existing?.lab_trailer_prepared_s3_url) && !s3UrlMatches;
  const sourceFps = await probeTrailerFps(s3Url);
  await writeTrailerLabState({ episodeId, sourceFps, s3Url });
  return { sourceFps, driftDetected, freshlyProbed: true };
}

/**
 * Decide whether a trailer's current s3Url differs from the one last encoded.
 * Used by the scanner to force a full re-run when an editor replaces the
 * source file without touching gcpUrl.
 */
export async function hasS3UrlDrifted({ episodeId, s3Url }) {
  if (!s3Url) return false;
  const existing = await readTrailerLabState(episodeId);
  if (!existing?.lab_trailer_prepared_s3_url) return false;
  return existing.lab_trailer_prepared_s3_url !== s3Url;
}

/**
 * Look up the lab's combined-master URL for a trailer. Used by the scanner's
 * sync-only fast path.
 */
export async function readCombinedMasterUrl(episodeId) {
  const client = await clientPromise();
  const labDb = client.db('chai_q_lab');
  const doc = await labDb.collection('video_episodes').findOne(
    { episode_id: episodeId },
    { projection: { combined_master_m3u8_url: 1 } },
  );
  return doc?.combined_master_m3u8_url || null;
}
