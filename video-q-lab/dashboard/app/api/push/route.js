import { NextResponse } from 'next/server';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TERMINAL = new Set(['FAILED', 'TIMED_OUT', 'ABORTED', 'SUCCEEDED']);

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

    const existing = await db.collection('video_episodes').findOne({ episode_id: episodeId });

    // Check for an active run BEFORE touching any data.
    if (existing?.lab_status === 'RUNNING') {
      if (!existing.lab_execution_arn) {
        // RUNNING flag set but no ARN — partial-failure state; block to be safe.
        return NextResponse.json(
          { error: 'A lab run is already active for this episode' },
          { status: 409 },
        );
      }
      try {
        const desc = await sfn.send(
          new DescribeExecutionCommand({ executionArn: existing.lab_execution_arn }),
        );
        if (!TERMINAL.has(desc.status)) {
          return NextResponse.json(
            { error: 'A lab run is already active for this episode' },
            { status: 409 },
          );
        }
        // desc.status is terminal — allow restart (fall through)
      } catch {
        // Cannot verify execution status; block to avoid data loss.
        return NextResponse.json(
          { error: 'A lab run is already active for this episode' },
          { status: 409 },
        );
      }
    }

    // Confirmed no active run — safe to clear previous results.
    await db.collection('video_vmaf_research').deleteMany({ episode_id: episodeId });

    const runStartedAt = new Date().toISOString();

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          lab_status: 'RUNNING',
          lab_run_started_at: runStartedAt,
        },
        $unset: {
          golden_recipes: '',
          lab_finished_at: '',
          h264_master_m3u8_url: '',
          h265_master_m3u8_url: '',
          gcp_job_status: '',
          gcp_job_name: '',
          gcp_execution_arn: '',
          gcp_started_at: '',
          gcp_finished_at: '',
          gcp_error: '',
          lab_error: '',
        },
      },
      { upsert: true },
    );

    const input = JSON.stringify({ s3_url: s3Url, episode_id: episodeId });
    const cmd = new StartExecutionCommand({ stateMachineArn: sfnArn, input });
    const result = await sfn.send(cmd);

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { lab_execution_arn: result.executionArn } },
    );

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/push]', err);
    return NextResponse.json({ error: 'Failed to start Step Function execution' }, { status: 500 });
  }
}
