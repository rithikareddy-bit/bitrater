import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KNOWN_URL_PATTERNS = [
  '_combined.m3u8',
  '/hls/',
  '/h264_master.m3u8',
  '/h265_master.m3u8',
  '/master.m3u8',
  'combined_master.m3u8',
  'stream.mux.com',
];

function isKnownPattern(url) {
  if (typeof url !== 'string') return true; // null/missing isn't a "URL pattern" issue
  return KNOWN_URL_PATTERNS.some((p) => url.includes(p));
}

function parseRateExpression(expr) {
  if (typeof expr !== 'string') return null;
  const m = expr.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('minute')) return n * 60;
  if (unit.startsWith('hour')) return n * 3600;
  return n * 86400;
}

export async function GET() {
  const alerts = [];
  try {
    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const runs = await labDb.collection('playback_resign_runs')
      .find({}, { projection: { started_at: 1, finished_at: 1, duration_s: 1, updated_count: 1, errors: 1 } })
      .sort({ started_at: -1 })
      .limit(2)
      .toArray();

    const cronIntervalSec = parseRateExpression(process.env.RESIGN_SCHEDULE_EXPRESSION || 'rate(2 hours)') || 7200;
    const lambdaTimeoutSec = 900;

    if (runs.length === 0) {
      alerts.push({ level: 'error', message: 'No cron runs found in playback_resign_runs collection.' });
    } else {
      const latest = runs[0];
      const finished = latest.finished_at ? new Date(latest.finished_at).getTime() : new Date(latest.started_at).getTime();
      const ageSec = (Date.now() - finished) / 1000;

      if (ageSec > cronIntervalSec * 2) {
        alerts.push({
          level: 'error',
          message: `Last cron run finished ${(ageSec / 3600).toFixed(1)}h ago — cron may have stalled (expected every ${(cronIntervalSec / 3600).toFixed(1)}h).`,
        });
      }

      const errCount = latest.errors?.length || 0;
      if (errCount > 0) {
        const first = latest.errors[0];
        alerts.push({
          level: 'error',
          message: `Last cron had ${errCount} error(s). First: ${first?.episode_id || 'unknown'} → ${first?.message || ''}`,
        });
      }

      if (latest.duration_s && latest.duration_s > lambdaTimeoutSec * 0.75) {
        alerts.push({
          level: 'warning',
          message: `Last cron took ${latest.duration_s.toFixed(0)}s — close to Lambda timeout (${lambdaTimeoutSec}s). Catalog may be growing past capacity.`,
        });
      }

      if (runs.length >= 2) {
        const curr = latest.updated_count || 0;
        const prev = runs[1].updated_count || 0;
        if (prev > 0 && curr < prev * 0.8) {
          alerts.push({
            level: 'error',
            message: `updated_count dropped from ${prev} → ${curr} (>20% drop). Possible Mongo schema rename or sweep failure mid-run.`,
          });
        }
      }
    }

    const sc = masterDb.collection('showcache');
    let unknownEpisodes = 0;
    let unknownTrailers = 0;
    const unknownSamples = [];
    const cursor = sc.find({}, {
      projection: {
        'episodes.signed_playback_url': 1,
        'trailers_playback_urls.gcpUrl': 1,
      },
    });
    for await (const show of cursor) {
      for (const ep of show.episodes || []) {
        const u = ep?.signed_playback_url;
        if (typeof u === 'string' && !isKnownPattern(u)) {
          unknownEpisodes++;
          if (unknownSamples.length < 3) unknownSamples.push(u);
        }
      }
      for (const t of show.trailers_playback_urls || []) {
        const u = t?.gcpUrl;
        if (typeof u === 'string' && !isKnownPattern(u)) {
          unknownTrailers++;
          if (unknownSamples.length < 3) unknownSamples.push(u);
        }
      }
    }
    if (unknownEpisodes + unknownTrailers > 0) {
      alerts.push({
        level: 'warning',
        message: `${unknownEpisodes + unknownTrailers} URLs (${unknownEpisodes} episodes + ${unknownTrailers} trailers) match no known pattern. Sample: ${unknownSamples[0]?.slice(0, 100)}`,
      });
    }

    return NextResponse.json({ alerts, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[GET /api/signing/alerts]', err);
    return NextResponse.json(
      { alerts: [{ level: 'error', message: `Alerts check failed: ${err.message}` }], generated_at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
