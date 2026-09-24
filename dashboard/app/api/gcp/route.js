import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { findEpisodeInShowcache, findTrailerInShowcase } from '@/lib/showcacheLookup';
import { resolveSourceUrl } from '@/lib/sourceUrl';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });
const execFileAsync = promisify(execFile);

// Detect whether the source has an audio track. GCP Transcoder rejects the job
// ("atom ... does not have any inputs with an audio track") when the config
// declares an audio elementaryStream/muxStream but the source is silent.
// On any probe failure we default to true to preserve prior behavior.
async function sourceHasAudio(s3Url) {
  try {
    const { url: probeUrl } = await resolveSourceUrl(s3Url, { expiresIn: 120 });
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      probeUrl,
    ], { timeout: 30000 });
    return stdout.trim().length > 0;
  } catch (err) {
    console.error('[POST /api/gcp] audio detect failed; defaulting hasAudio=true', err?.message);
    return true;
  }
}

export async function POST(request) {
  try {
    const { episodeId, codec, avRun } = await request.json();

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

    // Runs started from the /audio-video page keep their own status/URL fields
    // (`av_` prefix) so a classic Lab/GCP run on the same episode is never
    // overwritten, and the two never block each other's "already active" check.
    // Scoped to the RUN, not the episode: the show pipeline and episode page
    // send no flag and therefore keep writing the classic fields for every
    // episode — including one that has an Audio-Video ladder saved.
    const isAvRun = avRun === true;
    const pfx = isAvRun ? 'av_' : '';

    const statusKey = `${pfx}gcp_job_status_${codec}`;
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

    // The ladder is whatever golden_recipes carries — 1080/720/480 from the
    // Lab, or the 4-rung Audio-Video ladder (144p added). Every rung that
    // is present must have a recipe for this codec, otherwise the two codecs
    // would produce ladders of different heights.
    const resolutions = goldenRecipes.resolutions;
    const rungs = Object.keys(resolutions);
    const missing = rungs.filter((res) => !resolutions[res]?.[codec]?.bitrate_kbps);
    if (rungs.length === 0 || missing.length === rungs.length) {
      return NextResponse.json(
        { error: `No ${codec.toUpperCase()} bitrates found — run the lab or save an Audio-Video ladder first` },
        { status: 400 },
      );
    }
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing ${codec.toUpperCase()} bitrate for ${missing.join(', ')}` },
        { status: 400 },
      );
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

    const urlKey = `${pfx}${codec}_master_m3u8_url`;
    const execArnKey = `${pfx}gcp_execution_arn_${codec}`;
    const startedAtKey = `${pfx}gcp_started_at_${codec}`;
    const errorKey = `${pfx}gcp_error_${codec}`;
    const finishedAtKey = `${pfx}gcp_finished_at_${codec}`;
    const jobNameKey = `${pfx}gcp_job_name_${codec}`;
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
      // `av_run` rides along inside golden_recipes because that object already
      // flows through every state of the Step Function to finalize. It is not
      // persisted to Mongo, and the transcoder reads only `resolutions`.
      golden_recipes: isAvRun ? { ...goldenRecipes, av_run: true } : goldenRecipes,
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
