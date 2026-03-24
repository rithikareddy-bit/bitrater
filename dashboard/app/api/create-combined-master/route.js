import { NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const lambdaArn = process.env.CREATE_COMBINED_MASTER_LAMBDA_ARN;
    if (!lambdaArn) {
      return NextResponse.json(
        { error: 'CREATE_COMBINED_MASTER_LAMBDA_ARN not configured' },
        { status: 500 },
      );
    }

    const client = await clientPromise();
    const db = client.db('chai_q_lab');
    const episode = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { h264_master_m3u8_url: 1, h265_master_m3u8_url: 1 } },
    );

    if (!episode?.h264_master_m3u8_url) {
      return NextResponse.json(
        { error: 'H.264 master URL not ready — run GCP H.264 first' },
        { status: 400 },
      );
    }
    if (!episode?.h265_master_m3u8_url) {
      return NextResponse.json(
        { error: 'H.265 master URL not ready — run GCP H.265 first' },
        { status: 400 },
      );
    }

    const payload = JSON.stringify({ episode_id: episodeId });
    const cmd = new InvokeCommand({
      FunctionName: lambdaArn,
      Payload: Buffer.from(payload),
    });

    const result = await lambda.send(cmd);
    const responsePayload = JSON.parse(Buffer.from(result.Payload).toString());

    if (result.FunctionError) {
      const errMsg = responsePayload?.errorMessage || 'Lambda invocation failed';
      console.error('[POST /api/create-combined-master] Lambda error:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    return NextResponse.json({
      combined_master_m3u8_url: responsePayload.combined_master_m3u8_url,
    });
  } catch (err) {
    console.error('[POST /api/create-combined-master]', err);
    return NextResponse.json({ error: 'Failed to create combined master URL' }, { status: 500 });
  }
}
