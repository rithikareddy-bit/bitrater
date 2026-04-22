import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/trailer-runs?limit=30
 * Returns a flattened per-trailer activity feed from pipeline_runs (kind=trailer),
 * sorted newest first. Used by the Trailer Overview "Recent trailer activity" panel.
 */
export async function GET(request) {
  try {
    const { searchParams } = request.nextUrl;
    const limit = Math.min(parseInt(searchParams.get('limit') || '30', 10), 200);

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');

    // Pull extra runs so the flattened per-trailer list has enough rows even
    // when some runs had only a handful of trailers.
    const runs = await labDb.collection('pipeline_runs')
      .find({ kind: 'trailer' })
      .sort({ created_at: -1 })
      .limit(Math.max(limit, 30))
      .project({
        show_id: 1,
        show_title: 1,
        status: 1,
        is_batch: 1,
        created_at: 1,
        started_at: 1,
        finished_at: 1,
        total_episodes: 1,
        completed_count: 1,
        failed_count: 1,
        'episodes.episode_id': 1,
        'episodes.trailer_key': 1,
        'episodes.title': 1,
        'episodes.status': 1,
        'episodes.finished_at': 1,
        'episodes.synced_at': 1,
        'episodes.current_step': 1,
        'episodes.last_updated_at': 1,
        'episodes.error': 1,
        'episodes.show_id': 1,
        'episodes.show_title': 1,
      })
      .toArray();

    const rows = [];
    for (const run of runs) {
      const eps = Array.isArray(run.episodes) ? run.episodes : [];
      for (const ep of eps) {
        // Per-episode show info takes precedence for batch runs where the
        // run-level show_id is the '__batch__' sentinel.
        const epShowId = ep.show_id || (run.is_batch ? null : run.show_id) || null;
        const epShowTitle = ep.show_title || (run.is_batch ? null : run.show_title) || 'Untitled';
        rows.push({
          runId: String(run._id),
          showId: epShowId,
          showTitle: epShowTitle,
          runStatus: run.status || null,
          runCreatedAt: run.created_at || null,
          episodeId: ep.episode_id,
          trailerTitle: ep.title || ep.episode_id || 'Trailer',
          trailerKey: ep.trailer_key || null,
          status: ep.status || null,
          currentStep: ep.current_step || null,
          finishedAt: ep.finished_at || null,
          syncedAt: ep.synced_at || null,
          lastUpdatedAt: ep.last_updated_at || null,
          error: ep.error || null,
        });
      }
    }

    rows.sort((a, b) => {
      const ta = new Date(a.syncedAt || a.finishedAt || a.lastUpdatedAt || a.runCreatedAt || 0).getTime();
      const tb = new Date(b.syncedAt || b.finishedAt || b.lastUpdatedAt || b.runCreatedAt || 0).getTime();
      return tb - ta;
    });

    return NextResponse.json(
      { rows: rows.slice(0, limit), total: rows.length },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/trailer-runs]', err);
    return NextResponse.json({ error: 'Failed to load trailer runs' }, { status: 500 });
  }
}
