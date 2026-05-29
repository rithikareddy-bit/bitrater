import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

// POST /api/audio/convert  { episodeId }  -- re-run a single episode through the child machine.
export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });

    const arn = process.env.AUDIO_SFN_ARN;
    if (!arn) return NextResponse.json({ error: 'AUDIO_SFN_ARN not configured' }, { status: 500 });

    // resolve the episode's audio_url from podcast_showcache
    const client = await clientPromise();
    const show = await client
      .db('master')
      .collection('podcast_showcache')
      .findOne({ 'episodes.id': episodeId }, { projection: { 'episodes.$': 1 } });
    const ep = show?.episodes?.[0];
    if (!ep?.audio_url) {
      return NextResponse.json({ error: 'episode or audio_url not found' }, { status: 404 });
    }

    const res = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: arn,
        name: `audio-ep-${episodeId.slice(0, 30)}-${Date.now()}`,
        input: JSON.stringify({ episode_id: episodeId, audio_url: ep.audio_url }),
      }),
    );

    return NextResponse.json({ ok: true, executionArn: res.executionArn });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
