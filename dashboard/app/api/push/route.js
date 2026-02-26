import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId, s3Url } = await request.json();

    if (!episodeId || !s3Url) {
      return NextResponse.json({ error: 'episodeId and s3Url are required' }, { status: 400 });
    }

    const sfnArn = process.env.SFN_ARN;
    if (!sfnArn) {
      return NextResponse.json({ error: 'SFN_ARN not configured' }, { status: 500 });
    }

    const input = JSON.stringify({ s3_url: s3Url, episode_id: episodeId });
    const cmd = new StartExecutionCommand({ stateMachineArn: sfnArn, input });
    const result = await sfn.send(cmd);

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/push]', err);
    return NextResponse.json({ error: 'Failed to start Step Function execution' }, { status: 500 });
  }
}
