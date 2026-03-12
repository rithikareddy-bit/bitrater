import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

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

    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    await db.collection('video_vmaf_research').deleteMany({ episode_id: episodeId });

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $unset: {
        golden_recipes: '',
        h264_master_m3u8_url: '',
        h265_master_m3u8_url: '',
        gcp_job_status: '',
        gcp_job_name: '',
        gcp_started_at: '',
        gcp_finished_at: '',
        gcp_error: '',
      }},
    );

    const input = JSON.stringify({ s3_url: s3Url, episode_id: episodeId });
    const cmd = new StartExecutionCommand({ stateMachineArn: sfnArn, input });
    const result = await sfn.send(cmd);

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/push]', err);
    return NextResponse.json({ error: 'Failed to start Step Function execution' }, { status: 500 });
  }
}
