import { NextResponse } from 'next/server';
import { startWorkflow, workflowConfigError } from '@/lib/workflows';
import clientPromise from '@/lib/mongodb';
import { DB_MASTER } from '@/lib/config';

// POST /api/audio/convert  { episodeId }  -- re-run a single episode through the child machine.
export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });

    const configError = workflowConfigError('audio');
    if (configError) return NextResponse.json({ error: configError }, { status: 500 });

    // resolve the episode's audio_url from podcast_showcache
    const client = await clientPromise();
    const show = await client
      .db(DB_MASTER)
      .collection('podcast_showcache')
      .findOne({ 'episodes.id': episodeId }, { projection: { 'episodes.$': 1 } });
    const ep = show?.episodes?.[0];
    if (!ep?.audio_url) {
      return NextResponse.json({ error: 'episode or audio_url not found' }, { status: 404 });
    }

    const res = await startWorkflow(
      'audio',
      JSON.stringify({ episode_id: episodeId, audio_url: ep.audio_url }),
      { name: `audio-ep-${episodeId.slice(0, 30)}-${Date.now()}` },
    );

    return NextResponse.json({ ok: true, executionArn: res.executionArn });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
