import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const scheduleExpr = process.env.RESIGN_SCHEDULE_EXPRESSION || 'rate(105 minutes)';
  const ttlSeconds = parseInt(process.env.SIGNED_URL_TTL_SECONDS || '7200', 10);
  const cronIntervalSeconds = parseRateExpression(scheduleExpr);

  return NextResponse.json({
    schedule_expression: scheduleExpr,
    cron_interval_seconds: cronIntervalSeconds,
    ttl_seconds: ttlSeconds,
    stale_threshold_seconds: cronIntervalSeconds ? cronIntervalSeconds * 2 : 7200,
  });
}
