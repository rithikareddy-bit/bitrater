import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { runEpisodeGrid } from '@/lib/parallelResolLab';

export const dynamic = 'force-dynamic';

// Episode-page "Run lab · Resol": run ONE episode-codec's lab with the 3
// resolutions fanned into 3 parallel workers (each an in-container binary
// search). Lab-only — no GCP, matching the serial Run-lab button on this page.
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
      runEpisodeGrid(episodeId, s3Url, codec).catch((err) =>
        console.error('[parallel-resol/episode] runEpisodeGrid error', episodeId, codec, err));
    });

    return NextResponse.json({ ok: true, mode: 'parallel-resol', workers: 3, codec });
  } catch (err) {
    console.error('[POST /api/parallel-resol/episode]', err);
    return NextResponse.json({ error: 'Failed to start Resol lab' }, { status: 500 });
  }
}
