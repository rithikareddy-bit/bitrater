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

    const client = await clientPromise();
    const episode = await client
      .db('chai_q_lab')
      .collection('video_episodes')
      .findOne({ episode_id: id }, { projection: { combined_master_m3u8_url: 1 } });

    if (!episode?.combined_master_m3u8_url) {
      return NextResponse.json(
        { error: 'Combined master URL not ready — create it first' },
        { status: 400 },
      );
    }

    const cmd = new InvokeCommand({
      FunctionName: lambdaArn,
      InvocationType: 'Event', // async — don't wait for result
      Payload: Buffer.from(
        JSON.stringify({ episode_id: id, combined_url: episode.combined_master_m3u8_url }),
      ),
    });
    await lambda.send(cmd);

    // Mark as running in MongoDB so GET can return status
    await client
      .db('chai_q_lab')
      .collection('video_episodes')
      .updateOne(
        { episode_id: id },
        { $set: { 'quality_check.overall': 'RUNNING', 'quality_check.checked_at': null } },
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
