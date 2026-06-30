import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { findEpisodeInShowcache, findTrailerInShowcase } from '@/lib/showcacheLookup';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });
const execFileAsync = promisify(execFile);

function parseS3Url(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/^\//, '');
  if (host.startsWith('s3') && host.endsWith('.amazonaws.com')) {
    const bucket = path.split('/', 1)[0];
    const key = path.slice(bucket.length + 1);
    const segments = host.split('.');
    const region = segments.length >= 4 ? segments[1] : undefined;
    return { bucket, key, region };
  }
  const bucket = host.split('.s3')[0];
  const match = host.match(/\.s3\.([^.]+)\./);
  return { bucket, key: path, region: match ? match[1] : undefined };
}

// Detect whether the source has an audio track. GCP Transcoder rejects the job
// ("atom ... does not have any inputs with an audio track") when the config
// declares an audio elementaryStream/muxStream but the source is silent.
// On any probe failure we default to true to preserve prior behavior.
async function sourceHasAudio(s3Url) {
  try {
    const { bucket, key, region } = parseS3Url(s3Url);
    const s3 = new S3Client({ region: region || process.env.AWS_REGION || 'ap-south-2' });
    const presigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      presigned,
    ], { timeout: 30000 });
    return stdout.trim().length > 0;
  } catch (err) {
    console.error('[POST /api/gcp] audio detect failed; defaulting hasAudio=true', err?.message);
    return true;
  }
}

export async function POST(request) {
  try {
    const { episodeId, codec } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const gcpSfnArn = process.env.GCP_SFN_ARN;
    if (!gcpSfnArn) {
      return NextResponse.json({ error: 'GCP_SFN_ARN not configured' }, { status: 500 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const episode = await labDb.collection('video_episodes').findOne({ episode_id: episodeId });

    const statusKey = `gcp_job_status_${codec}`;
    const status = episode?.[statusKey];
    if (status === 'RUNNING' || status === 'PENDING') {
      return NextResponse.json(
        { error: `A GCP ${codec.toUpperCase()} job is already active for this episode` },
        { status: 409 },
      );
    }

    const goldenRecipes = episode?.golden_recipes;
    if (!goldenRecipes?.resolutions) {
      return NextResponse.json({ error: 'Lab results (golden_recipes) not found' }, { status: 400 });
    }

    const sourceFps = episode?.source_fps;
    if (!sourceFps) {
      return NextResponse.json(
        { error: 'source_fps is missing. Re-run the lab to detect FPS.' },
        { status: 400 },
      );
    }

    const resolutions = goldenRecipes.resolutions;
    for (const res of ['1080p', '720p', '480p']) {
      const recipe = resolutions[res]?.[codec];
      if (!recipe) {
        return NextResponse.json(
          { error: `Missing ${codec.toUpperCase()} golden recipe for ${res} — run the lab first` },
          { status: 400 },
        );
      }
    }

    // Resolve source URL + (for trailers) the slug prefix seed that the
    // finalize/combine Lambdas use to build file names.
    const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;
    const trailerMatch = TRAILER_ID_RE.exec(episodeId);
    let s3Url;
    let itemKind = 'episode';
    let trailerKey = null;
    let showSlug = null;
    if (trailerMatch) {
      itemKind = 'trailer';
      const [, showIdHex, key] = trailerMatch;
      trailerKey = key;
      const showDoc = await findTrailerInShowcase(
        masterDb,
        new ObjectId(showIdHex),
        key,
        { slug: 1, 'trailers_playback_urls.$': 1 },
      );
      const trailer = showDoc?.trailers_playback_urls?.[0];
      s3Url = trailer?.s3Url || trailer?.s3_url;
      showSlug = showDoc?.slug || null;
      if (!s3Url) {
        return NextResponse.json({ error: 'No s3Url found for this trailer' }, { status: 400 });
      }
    } else {
      const showWithEp = await findEpisodeInShowcache(masterDb, episodeId);
      s3Url = showWithEp?.episodes?.[0]?.s3_url;
      if (!s3Url) {
        return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
      }
    }

    const hasAudio = await sourceHasAudio(s3Url);

    const urlKey = codec === 'h264' ? 'h264_master_m3u8_url' : 'h265_master_m3u8_url';
    const execArnKey = `gcp_execution_arn_${codec}`;
    const startedAtKey = `gcp_started_at_${codec}`;
    const errorKey = `gcp_error_${codec}`;
    const finishedAtKey = `gcp_finished_at_${codec}`;
    const jobNameKey = `gcp_job_name_${codec}`;
    const now = new Date().toISOString();

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          [statusKey]: 'PENDING',
          [startedAtKey]: now,
          [execArnKey]: null,
          [errorKey]: null,
          [finishedAtKey]: null,
          [jobNameKey]: null,
        },
        $unset: { [urlKey]: '', gcp_subtitle_error: '' },
      },
    );

    const input = JSON.stringify({
      episode_id: episodeId,
      s3_url: s3Url,
      golden_recipes: goldenRecipes,
      codec,
      source_fps: sourceFps,
      has_audio: hasAudio,
      kind: itemKind,
      ...(itemKind === 'trailer' ? { trailer_key: trailerKey, show_slug: showSlug } : {}),
    });

    let result;
    try {
      const cmd = new StartExecutionCommand({ stateMachineArn: gcpSfnArn, input });
      result = await sfn.send(cmd);
    } catch (sfnErr) {
      await labDb.collection('video_episodes').updateOne(
        { episode_id: episodeId },
        {
          $set: {
            [statusKey]: 'FAILED',
            [errorKey]: sfnErr.message || 'Failed to start Step Function',
            [finishedAtKey]: new Date().toISOString(),
          },
        },
      );
      throw sfnErr;
    }

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { [execArnKey]: result.executionArn } },
    );

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/gcp]', err);
    return NextResponse.json({ error: 'Failed to start GCP pipeline' }, { status: 500 });
  }
}
