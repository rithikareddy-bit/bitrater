import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { scanTrailersOnce } from '@/lib/trailerScanner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SETTINGS_ID = 'trailer_scanner';

async function readSetting() {
  const client = await clientPromise();
  const labDb = client.db('chai_q_lab');
  const doc = await labDb.collection('scanner_settings').findOne({ _id: SETTINGS_ID });
  return {
    enabled: Boolean(doc?.enabled),
    updated_at: doc?.updated_at || null,
    updated_by: doc?.updated_by || null,
  };
}

export async function GET() {
  try {
    const state = await readSetting();
    return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    console.error('[GET /api/trailer-scanner]', err);
    return NextResponse.json({ error: 'Failed to read scanner state' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'body.enabled must be a boolean' }, { status: 400 });
    }
    const updatedBy = typeof body?.updatedBy === 'string' ? body.updatedBy : null;

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');

    // Detect OFF→ON edge so we can kick off an immediate scan — otherwise the
    // operator has to wait up to 5 min for the next scheduled tick.
    const prior = await labDb.collection('scanner_settings').findOne({ _id: SETTINGS_ID });
    const wasEnabled = Boolean(prior?.enabled);
    const nowEnabled = body.enabled;

    const now = new Date();
    await labDb.collection('scanner_settings').updateOne(
      { _id: SETTINGS_ID },
      { $set: { enabled: nowEnabled, updated_at: now, updated_by: updatedBy } },
      { upsert: true },
    );

    if (nowEnabled && !wasEnabled) {
      // Fire-and-forget — don't block the HTTP response on the scan duration.
      // `force: true` bypasses the flag check (in case of racing reads).
      setImmediate(() => {
        scanTrailersOnce({ force: true }).catch(err => {
          console.error('[trailer-scanner] immediate scan after enable failed:', err);
        });
      });
    }

    return NextResponse.json({
      ...(await readSetting()),
      triggeredImmediateScan: nowEnabled && !wasEnabled,
    });
  } catch (err) {
    console.error('[POST /api/trailer-scanner]', err);
    return NextResponse.json({ error: 'Failed to update scanner state' }, { status: 500 });
  }
}
