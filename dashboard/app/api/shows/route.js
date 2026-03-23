import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { resolveShowPosterUrl } from '@/lib/posterUrl';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

function toIsoString(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function parseIntParam(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request) {
  try {
    const { searchParams } = request.nextUrl;
    const limit = Math.min(
      Math.max(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), 1),
      MAX_LIMIT
    );
    const skip = Math.max(parseIntParam(searchParams.get('skip'), 0), 0);

    const client = await clientPromise();
    const db = client.db('master');

    const [facet] = await db
      .collection('showcache')
      .aggregate([
        {
          $addFields: {
            _updatedSort: {
              $convert: {
                input: '$updated_at',
                to: 'date',
                onError: null,
                onNull: null,
              },
            },
            _createdSort: {
              $convert: {
                input: '$created_at',
                to: 'date',
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $addFields: {
            _sortGroup: {
              $switch: {
                branches: [
                  { case: { $ne: ['$_updatedSort', null] }, then: 2 },
                  { case: { $ne: ['$_createdSort', null] }, then: 1 },
                ],
                default: 0,
              },
            },
          },
        },
        {
          $sort: {
            _sortGroup: -1,
            _updatedSort: -1,
            _createdSort: -1,
            _id: -1,
          },
        },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $project: {
                  _id: 1,
                  title: 1,
                  thumbnail: 1,
                  s3_primary_poster_id: 1,
                  s3_primary_poster_ids: 1,
                  preview_gif: 1,
                  updated_at: 1,
                  created_at: 1,
                  episodeCount: {
                    $cond: {
                      if: {
                        $in: [{ $type: '$episode_count' }, ['int', 'long', 'double', 'decimal']],
                      },
                      then: '$episode_count',
                      else: { $size: { $ifNull: ['$episodes', []] } },
                    },
                  },
                },
              },
            ],
            total: [{ $count: 'n' }],
          },
        },
      ])
      .toArray();

    const shows = (facet?.data ?? []).map((s) => {
      const posterUrl = resolveShowPosterUrl(s);
      return {
        _id: s._id,
        title: s.title,
        episodeCount: s.episodeCount,
        posterUrl,
        updatedAt: toIsoString(s.updated_at),
        createdAt: toIsoString(s.created_at),
      };
    });
    const total = facet?.total?.[0]?.n ?? 0;
    const hasMore = skip + shows.length < total;

    return NextResponse.json({ shows, total, limit, skip, hasMore });
  } catch (err) {
    console.error('[GET /api/shows]', err);
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 });
  }
}