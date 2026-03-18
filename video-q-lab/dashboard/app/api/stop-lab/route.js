import { NextResponse } from 'next/server';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const episode = await db.collection('video_episodes').findOne({ episode_id: episodeId });

    if (!episode?.lab_execution_arn) {
      return NextResponse.json({ error: 'No execution ARN found for this episode' }, { status: 400 });
    }

    await sfn.send(
      new StopExecutionCommand({
        executionArn: episode.lab_execution_arn,
        cause: 'Stopped by user from dashboard',
      }),
    );

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          lab_status: 'FAILED',
          lab_error: 'Stopped by user',
        },
      },
    );

    return NextResponse.json({ stopped: true });
  } catch (err) {
    console.error('[POST /api/stop-lab]', err);
    return NextResponse.json({ error: 'Failed to stop lab execution' }, { status: 500 });
  }
}
