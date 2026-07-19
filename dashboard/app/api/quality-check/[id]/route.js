import { NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

// POST /api/quality-check/[id] — invoke quality checker Lambda
export async function POST(request, { params }) {
  const { id } = params;
  try {
    const lambdaArn = process.env.QUALITY_CHECK_LAMBDA_ARN;
    if (!lambdaArn) {
      return NextResponse.json(
        { error: 'QUALITY_CHECK_LAMBDA_ARN not configured' },
        { status: 500 },
      );
    }

    // The QC Lambda reads the unsigned h264_master_m3u8_url from
    // chai_q_lab.video_episodes itself (by episode_id), so we only pass the id.
    // If the episode has no H.264 master yet, the Lambda records overall=ERROR.
    const cmd = new InvokeCommand({
      FunctionName: lambdaArn,
      InvocationType: 'Event', // async — don't wait for result
      Payload: Buffer.from(JSON.stringify({ episode_id: id })),
    });
    await lambda.send(cmd);

    // Mark as running in MongoDB so GET can return status. Replace the whole
    // quality_check field (not dot-notation keys): auto-pipeline start/cancel
    // leave it as scalar `null`, and `$set: {'quality_check.overall': ...}` on a
    // null field throws MongoServerError code 28. The Lambda overwrites the whole
    // field on completion, so there is no partial result to preserve here.
    const client = await clientPromise();
    await client
      .db('chai_q_lab')
      .collection('video_episodes')
      .updateOne(
        { episode_id: id },
        { $set: { quality_check: { overall: 'RUNNING', checked_at: null } } },
      );

    return NextResponse.json({ status: 'RUNNING' });
  } catch (err) {
    console.error('[POST /api/quality-check/[id]]', err);
    return NextResponse.json({ error: 'Failed to trigger quality check' }, { status: 500 });
  }
}

// GET /api/quality-check/[id] — fetch stored results
export async function GET(request, { params }) {
  const { id } = params;
  try {
    const client = await clientPromise();
    const episode = await client
      .db('chai_q_lab')
      .collection('video_episodes')
      .findOne({ episode_id: id }, { projection: { quality_check: 1 } });

    return NextResponse.json(episode?.quality_check || null);
  } catch (err) {
    console.error('[GET /api/quality-check/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch quality check results' }, { status: 500 });
  }
}
