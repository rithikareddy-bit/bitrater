import { NextResponse } from 'next/server';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TERMINAL = new Set(['FAILED', 'TIMED_OUT', 'ABORTED', 'SUCCEEDED']);

const CODEC_TO_LIB = { h264: 'libx264', h265: 'libx265' };

export async function POST(request) {
  try {
    const { episodeId, s3Url, codec } = await request.json();

    if (!episodeId || !s3Url) {
      return NextResponse.json({ error: 'episodeId and s3Url are required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const sfnArn = codec === 'h264'
      ? process.env.SFN_ARN_H264
      : process.env.SFN_ARN_H265;
    if (!sfnArn) {
      return NextResponse.json(
        { error: `SFN_ARN_${codec.toUpperCase()} not configured` },
        { status: 500 },
      );
    }

    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const statusKey = `lab_status_${codec}`;
    const arnKey = `lab_execution_arn_${codec}`;
    const existing = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { [statusKey]: 1, [arnKey]: 1 } },
    );

    if (existing?.[statusKey] === 'RUNNING') {
      const execArn = existing[arnKey];
      if (execArn) {
        try {
          const desc = await sfn.send(
            new DescribeExecutionCommand({ executionArn: execArn }),
          );
          if (desc.status === 'RUNNING') {
            return NextResponse.json(
              { error: `A lab run (H.${codec === 'h264' ? '264' : '265'}) is already active for this episode` },
              { status: 409 },
            );
          }
          if (!TERMINAL.has(desc.status)) {
            return NextResponse.json(
              { error: `A lab run (H.${codec === 'h264' ? '264' : '265'}) is already active for this episode` },
              { status: 409 },
            );
          }
        } catch {
          return NextResponse.json(
            { error: `A lab run (H.${codec === 'h264' ? '264' : '265'}) is already active for this episode` },
            { status: 409 },
          );
        }
      }
    }

    const libCodec = CODEC_TO_LIB[codec];
    await db.collection('video_vmaf_research').deleteMany({
      episode_id: episodeId,
      codec: libCodec,
    });

    const runStartedAt = new Date().toISOString();
    const labRunId = randomUUID();
    const startedAtKey = `lab_run_started_at_${codec}`;
    const runIdKey = `lab_run_id_${codec}`;
    const errorKey = `lab_error_${codec}`;

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          [statusKey]: 'RUNNING',
          [startedAtKey]: runStartedAt,
          [runIdKey]: labRunId,
        },
        $unset: {
          [errorKey]: '',
          [`search_progress_${codec}`]: '',
          // Clear stale golden_recipes for this codec so the UI doesn't show old winners
          [`golden_recipes.resolutions.1080p.${codec}`]: '',
          [`golden_recipes.resolutions.720p.${codec}`]: '',
          [`golden_recipes.resolutions.480p.${codec}`]: '',
          // Efficiency gain depends on both codecs — will be recomputed by aggregator
          'efficiency_gain': '',
        },
      },
      { upsert: true },
    );

    const input = JSON.stringify({
      s3_url: s3Url,
      episode_id: episodeId,
      codec,
      run_id: labRunId,
    });
    const cmd = new StartExecutionCommand({ stateMachineArn: sfnArn, input });
    const result = await sfn.send(cmd);

    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { [arnKey]: result.executionArn } },
    );

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/push]', err);
    return NextResponse.json({ error: 'Failed to start Step Function execution' }, { status: 500 });
  }
}
