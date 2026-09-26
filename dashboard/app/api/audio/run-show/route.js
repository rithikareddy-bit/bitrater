import { NextResponse } from 'next/server';
import { startWorkflow, workflowConfigError } from '@/lib/workflows';

// POST /api/audio/run-show  { slug, force? }
// Starts the per-show batch state machine (Map, 30-wide, refill on finish).
export async function POST(request) {
  try {
    const { slug, force = false } = await request.json();
    if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

    const configError = workflowConfigError('audio_show');
    if (configError) {
      return NextResponse.json({ error: configError }, { status: 500 });
    }

    const safe = slug.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);
    const name = `audio-${safe}-${Date.now()}`;

    const res = await startWorkflow('audio_show', JSON.stringify({ slug, force: Boolean(force) }), { name });

    return NextResponse.json({ ok: true, executionArn: res.executionArn });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
