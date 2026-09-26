import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { findEpisodeInShowcache } from '@/lib/showcacheLookup';
import { probeTrailerFps } from '@/lib/trailerPrep';
import { AV_RESOLUTIONS, isAudioVideoRecipe } from '@/lib/avLadder';
import { DB_LAB, DB_MASTER } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Audio-Video bitrates — the Lab-free path.
 *
 * GET  ?episodeId=…  → the episode's source s3_url + whatever ladder is saved.
 * POST { episodeId, bitrates } → writes the hand-entered ladder as
 *   golden_recipes and marks the Lab COMPLETE, which is exactly what
 *   /api/gcp expects to find. FPS is probed from the source because the GCP
 *   Lambda needs source_fps for GOP alignment.
 */

function parseKbps(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  // 20000 kbps ceiling: anything higher is a typo (e.g. bps pasted as kbps),
  // and submitting it would burn a very expensive transcode before anyone notices.
  if (!Number.isInteger(n) || n <= 0 || n > 20000) return NaN;
  return n;
}

export async function GET(request) {
  try {
    const episodeId = request.nextUrl.searchParams.get('episodeId');
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const showWithEp = await findEpisodeInShowcache(
      client.db(DB_MASTER),
      episodeId,
      { 'episodes.$': 1, slug: 1 },
    );
    const episode = showWithEp?.episodes?.[0] ?? null;

    const doc = await client.db(DB_LAB).collection('video_episodes').findOne(
      { episode_id: episodeId },
      {
        projection: {
          golden_recipes: 1,
          source_fps: 1,
          av_ladder: 1,
          av_ladder_saved_at: 1,
          gcp_job_status_h264: 1,
          gcp_job_status_h265: 1,
          av_gcp_job_status_h264: 1,
          av_gcp_job_status_h265: 1,
        },
      },
    );

    return NextResponse.json({
      episodeId,
      s3Url: episode?.s3_url ?? null,
      title: episode?.title ?? null,
      showSlug: showWithEp?.slug ?? null,
      goldenRecipes: doc?.golden_recipes ?? null,
      sourceFps: doc?.source_fps ?? null,
      // Derived from the recipe, not the stored av_ladder flag — a Lab run that
      // replaced golden_recipes must stop reporting as an Audio-Video ladder.
      isAvLadder: isAudioVideoRecipe(doc?.golden_recipes),
      savedAt: doc?.av_ladder_saved_at ?? null,
    });
  } catch (err) {
    console.error('[GET /api/audio-video/bitrates]', err);
    return NextResponse.json({ error: 'Failed to load bitrates' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { episodeId, bitrates } = await request.json();
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!bitrates || typeof bitrates !== 'object') {
      return NextResponse.json({ error: 'bitrates is required' }, { status: 400 });
    }

    // Build the ladder. A rung is included only when BOTH codecs have a
    // bitrate — a half-filled rung would make the H.264 and H.265 ladders
    // different heights, and the combined master would advertise a rung that
    // only exists for one codec.
    const resolutions = {};
    for (const res of AV_RESOLUTIONS) {
      const h264 = parseKbps(bitrates[res]?.h264);
      const h265 = parseKbps(bitrates[res]?.h265);
      if (Number.isNaN(h264) || Number.isNaN(h265)) {
        return NextResponse.json(
          { error: `${res}: bitrate must be a whole number of kbps between 1 and 20000` },
          { status: 400 },
        );
      }
      if (h264 == null && h265 == null) continue;
      if (h264 == null || h265 == null) {
        return NextResponse.json(
          { error: `${res}: fill in both H.264 and H.265, or leave the whole row blank` },
          { status: 400 },
        );
      }
      resolutions[res] = {
        h264: { bitrate_kbps: h264, pass: true, vmaf_attained: null },
        h265: { bitrate_kbps: h265, pass: true, vmaf_attained: null },
      };
    }

    if (Object.keys(resolutions).length === 0) {
      return NextResponse.json({ error: 'Enter at least one resolution' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db(DB_LAB);

    const showWithEp = await findEpisodeInShowcache(client.db(DB_MASTER), episodeId);
    const s3Url = showWithEp?.episodes?.[0]?.s3_url;
    if (!s3Url) {
      return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
    }

    const existing = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      {
        projection: {
          gcp_job_status_h264: 1, gcp_job_status_h265: 1,
          av_gcp_job_status_h264: 1, av_gcp_job_status_h265: 1,
          source_fps: 1,
        },
      },
    );
    // Block on either namespace: an Audio-Video run (av_*) is the usual case
    // here, but a classic run on the same episode also means the ladder is
    // mid-flight and must not change underneath it.
    const active = ['PENDING', 'RUNNING'];
    const anyActive = [
      existing?.gcp_job_status_h264, existing?.gcp_job_status_h265,
      existing?.av_gcp_job_status_h264, existing?.av_gcp_job_status_h265,
    ].some((s) => active.includes(s));
    if (anyActive) {
      return NextResponse.json(
        { error: 'A GCP job is active for this episode — wait for it to finish before changing bitrates.' },
        { status: 409 },
      );
    }

    // GOP alignment needs the true source FPS. Reuse the cached value when we
    // already probed this episode; probing streams the source through ffprobe
    // and is the slow part of this request.
    const sourceFps = existing?.source_fps ?? (await probeTrailerFps(s3Url));

    const nowIso = new Date().toISOString();
    const goldenRecipes = { resolutions, ladder: 'audio_video' };

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          episode_id: episodeId,
          source_fps: sourceFps,
          golden_recipes: goldenRecipes,
          av_ladder: true,
          av_ladder_saved_at: nowIso,
          av_ladder_source_s3_url: s3Url,
          // The GCP route gates on golden recipes existing, and the show
          // overview reads lab_status — mark both COMPLETE so a hand-entered
          // ladder behaves exactly like a Lab-produced one.
          lab_status_h264: 'COMPLETE',
          lab_status_h265: 'COMPLETE',
          lab_finished_at_h264: nowIso,
          lab_finished_at_h265: nowIso,
        },
        $unset: { lab_error_h264: '', lab_error_h265: '' },
      },
      { upsert: true },
    );

    return NextResponse.json({
      ok: true,
      episodeId,
      sourceFps,
      goldenRecipes,
      resolutions: Object.keys(resolutions),
    });
  } catch (err) {
    console.error('[POST /api/audio-video/bitrates]', err);
    return NextResponse.json(
      { error: err.message || 'Failed to save bitrates' },
      { status: 500 },
    );
  }
}
