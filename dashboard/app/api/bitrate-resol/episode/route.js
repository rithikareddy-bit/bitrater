import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { runEpisodeBitrateResol } from '@/lib/parallelResolLab';

export const dynamic = 'force-dynamic';

// Episode-page "Bitrate Resol": run ONE episode-codec's lab BITRATE-WISE — one
// worker per candidate bitrate across all 3 resolutions at once, early-cancelling
// higher bitrates once a lower one passes its VMAF threshold. Lab-only (no GCP),
// matching the serial Run-lab / Resol buttons on this page.
export async function POST(request) {
  try {
    const { episodeId, s3Url, codec } = await request.json();
    if (!episodeId || !s3Url) {
      return NextResponse.json({ error: 'episodeId and s3Url are required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db('chai_q_lab');
    const existing = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { [`lab_status_${codec}`]: 1 } },
    );
    if (existing?.[`lab_status_${codec}`] === 'RUNNING') {
      return NextResponse.json(
        { error: `A H.${codec === 'h264' ? '264' : '265'} lab is already running for this episode` },
        { status: 409 },
      );
    }

    setImmediate(() => {
      runEpisodeBitrateResol(episodeId, s3Url, codec).catch((err) =>
        console.error('[bitrate-resol/episode] runEpisodeBitrateResol error', episodeId, codec, err));
    });

    return NextResponse.json({ ok: true, mode: 'bitrate-resol', codec });
  } catch (err) {
    console.error('[POST /api/bitrate-resol/episode]', err);
    return NextResponse.json({ error: 'Failed to start Bitrate Resol lab' }, { status: 500 });
  }
}
