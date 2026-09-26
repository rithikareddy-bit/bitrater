export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { DB_LAB } from '@/lib/config';

// GET /api/url-health
// Returns the most recent health-check run (or ?run_id=<id> for a specific one).
// Query params:
//   run_id   — fetch a specific run by _id string
//   failed   — if "1", return only failed results from the latest run
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('run_id');
  const failedOnly = searchParams.get('failed') === '1';

  try {
    const client = await clientPromise();
    const col = client.db(DB_LAB).collection('url_health_runs');

    let run;
    if (runId) {
      const { ObjectId } = await import('mongodb');
      run = await col.findOne({ _id: new ObjectId(runId) });
    } else {
      run = await col.findOne({}, { sort: { started_at: -1 } });
    }

    if (!run) {
      return NextResponse.json({ no_runs: true, results: [], summary: { total: 0, ok: 0, failed: 0 } });
    }

    let results = run.results ?? [];
    if (failedOnly) {
      results = results.filter((r) => !r.ok);
    }

    return NextResponse.json({
      run_id: run._id.toString(),
      started_at: run.started_at,
      finished_at: run.finished_at,
      summary: run.summary,
      results,
    });
  } catch (err) {
    console.error('[url-health]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
