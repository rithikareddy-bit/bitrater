import { NextResponse } from 'next/server';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId, codec } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const arnKey = `lab_execution_arn_${codec}`;
    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { [arnKey]: 1 } },
    );

    const execArn = episode?.[arnKey];
    if (!execArn) {
      return NextResponse.json({ error: 'No execution ARN found for this codec' }, { status: 400 });
    }

    await sfn.send(
      new StopExecutionCommand({
        executionArn: execArn,
        cause: 'Stopped by user from dashboard',
      }),
    );

    const statusKey = `lab_status_${codec}`;
    const errorKey = `lab_error_${codec}`;
    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          [statusKey]: 'FAILED',
          [errorKey]: 'Stopped by user',
        },
      },
    );

    return NextResponse.json({ stopped: true });
  } catch (err) {
    console.error('[POST /api/stop-lab]', err);
    return NextResponse.json({ error: 'Failed to stop lab execution' }, { status: 500 });
  }
}
