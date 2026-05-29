import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

// POST /api/audio/run-show  { slug, force? }
// Starts the per-show batch state machine (Map, 30-wide, refill on finish).
export async function POST(request) {
  try {
    const { slug, force = false } = await request.json();
    if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

    const arn = process.env.AUDIO_SHOW_BATCH_SFN_ARN;
    if (!arn) {
      return NextResponse.json({ error: 'AUDIO_SHOW_BATCH_SFN_ARN not configured' }, { status: 500 });
    }

    const safe = slug.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);
    const name = `audio-${safe}-${Date.now()}`;

    const res = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: arn,
        name,
        input: JSON.stringify({ slug, force: Boolean(force) }),
      }),
    );

    return NextResponse.json({ ok: true, executionArn: res.executionArn });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
