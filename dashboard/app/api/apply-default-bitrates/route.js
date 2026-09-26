import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { findEpisodeInShowcache, findTrailerInShowcase } from '@/lib/showcacheLookup';
import { probeTrailerFps } from '@/lib/trailerPrep';
import { isAudioVideoRecipe } from '@/lib/avLadder';
import { DB_LAB, DB_MASTER } from '@/lib/config';

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

const LADDER = {
  low: {
    '1080p': { h264: 5000, h265: 4000 },
    '720p':  { h264: 3000, h265: 2000 },
    '480p':  { h264: 1200, h265: 800 },
  },
  high: {
    '1080p': { h264: 7500, h265: 6000 },
    '720p':  { h264: 4500, h265: 3000 },
    '480p':  { h264: 1800, h265: 1200 },
  },
};

function buildGoldenRecipes(fps) {
  const tier = fps >= 60 ? 'high' : 'low';
  const table = LADDER[tier];
  const resolutions = {};
  for (const res of ['1080p', '720p', '480p']) {
    resolutions[res] = {
      h264: { bitrate_kbps: table[res].h264, pass: true, vmaf_attained: null },
      h265: { bitrate_kbps: table[res].h265, pass: true, vmaf_attained: null },
    };
  }
  return { resolutions, fps_tier: tier };
}

export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db(DB_MASTER);
    const labDb = client.db(DB_LAB);

    const trailerMatch = TRAILER_ID_RE.exec(episodeId);
    let s3Url;
    if (trailerMatch) {
      const [, showIdHex, key] = trailerMatch;
      const showDoc = await findTrailerInShowcase(masterDb, new ObjectId(showIdHex), key);
      const trailer = showDoc?.trailers_playback_urls?.[0];
      s3Url = trailer?.s3Url || trailer?.s3_url;
    } else {
      const showWithEp = await findEpisodeInShowcache(masterDb, episodeId);
      s3Url = showWithEp?.episodes?.[0]?.s3_url;
    }
    if (!s3Url) {
      return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
    }

    const existing = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { lab_status_h264: 1, lab_status_h265: 1, golden_recipes: 1 } },
    );
    if (existing?.lab_status_h264 === 'RUNNING' || existing?.lab_status_h265 === 'RUNNING') {
      return NextResponse.json(
        { error: 'A lab run is currently active for this episode — stop it before applying defaults.' },
        { status: 409 },
      );
    }
    // This button writes the classic 1080/720/480 ladder. On an episode set up
    // from the Audio-Video page that would silently drop the 144p rung (and its
    // loudness normalization) — so refuse and send the operator to the page that
    // owns that ladder.
    if (isAudioVideoRecipe(existing?.golden_recipes)) {
      return NextResponse.json(
        {
          error:
            'This episode uses the Audio-Video ladder (144p/720p/480p/1080p). '
            + 'Applying the classic defaults here would drop the 144p rung. '
            + 'Edit its bitrates on the Audio-Video page instead.',
        },
        { status: 409 },
      );
    }

    const sourceFps = await probeTrailerFps(s3Url);
    const goldenRecipes = buildGoldenRecipes(sourceFps);
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
          lab_defaults_applied: true,
          lab_defaults_applied_at: nowIso,
          lab_defaults_source_s3_url: s3Url,
          lab_finished_at_h264: nowIso,
          lab_finished_at_h265: nowIso,
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

    return NextResponse.json({
      ok: true,
      fps: sourceFps,
      tier: sourceFps >= 60 ? 'high' : 'low',
      goldenRecipes,
    });
  } catch (err) {
    console.error('[POST /api/apply-default-bitrates]', err);
    return NextResponse.json({ error: err.message || 'Failed to apply default bitrates' }, { status: 500 });
  }
}
