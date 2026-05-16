import { NextResponse } from 'next/server';
import { verifyUploadToken, publicS3Url } from '@/lib/uploadConfig';
import { getProdShowcase, getDevShowcase, findEpisode } from '@/lib/uploadMongo';

async function strictWrite(col, { slug, episodeNumber, episodeId, expectedCurrent, finalUrl, previousUpdatedAt, now }) {
  const filter = { 'ep.episode_number': Number(episodeNumber) };
  if (episodeId) filter['ep.id'] = episodeId;
  if (expectedCurrent) filter['ep.s3_url'] = expectedCurrent;
  else filter.$or = [{ 'ep.s3_url': null }, { 'ep.s3_url': '' }, { 'ep.s3_url': { $exists: false } }];

  const set = {
    'episodes.$[ep].s3_url': finalUrl,
    'episodes.$[ep].s3_url_updated_at': now,
    updated_at: now,
  };
  if (expectedCurrent) {
    set['episodes.$[ep].s3_url_previous'] = expectedCurrent;
    set['episodes.$[ep].s3_url_previous_at'] = previousUpdatedAt || now;
  }
  const res = await col.updateOne({ slug }, { $set: set }, { arrayFilters: [filter] });
  return res.matchedCount > 0 && res.modifiedCount > 0;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const t = verifyUploadToken(body.uploadToken);
    if (!t) return NextResponse.json({ error: 'invalid uploadToken' }, { status: 401 });

    const finalUrl = publicS3Url(t.key);
    const overwrite = body.overwrite === true;

    // Prod pre-flight + overwrite gate.
    const prodCol = await getProdShowcase();
    const prodShow = await prodCol.findOne({ slug: t.slug }, { projection: { episodes: 1 } });
    if (!prodShow) return NextResponse.json({ error: 'show not found in prod' }, { status: 404 });
    const { episode: prodEp } = findEpisode(prodShow, t.episodeNumber);
    if (!prodEp) return NextResponse.json({ error: 'episode not found in prod' }, { status: 404 });
    if (prodEp.s3_url && !overwrite) {
      return NextResponse.json({
        error: 'existing s3_url present; resend with overwrite=true to replace',
        existingS3Url: prodEp.s3_url,
      }, { status: 409 });
    }

    const now = new Date();
    const episodeId = prodEp.id || null;

    // Prod write — strict, race-safe.
    const prodOk = await strictWrite(prodCol, {
      slug: t.slug, episodeNumber: t.episodeNumber, episodeId,
      expectedCurrent: prodEp.s3_url || null, finalUrl,
      previousUpdatedAt: prodEp.s3_url_updated_at || null, now,
    });
    if (!prodOk) {
      return NextResponse.json({
        error: 'prod showcache write rejected — episode changed since you started (concurrent writer?)',
        url: finalUrl,
      }, { status: 409 });
    }

    // Dev write — best effort, with dev's own state.
    let dev = { attempted: false };
    try {
      const devCol = await getDevShowcase();
      if (!devCol) {
        dev = { attempted: false, reason: 'SUBTITLE_MONGO_URI not configured' };
      } else {
        const devShow = await devCol.findOne({ slug: t.slug }, { projection: { episodes: 1 } });
        if (!devShow) dev = { attempted: true, ok: false, reason: 'slug not found in dev' };
        else {
          const { episode: devEp } = findEpisode(devShow, t.episodeNumber);
          if (!devEp) dev = { attempted: true, ok: false, reason: 'episode not found in dev' };
          else {
            const devOk = await strictWrite(devCol, {
              slug: t.slug, episodeNumber: t.episodeNumber, episodeId,
              expectedCurrent: devEp.s3_url || null, finalUrl,
              previousUpdatedAt: devEp.s3_url_updated_at || null, now,
            });
            dev = devOk
              ? { attempted: true, ok: true }
              : { attempted: true, ok: false, reason: 'dev episode changed mid-write' };
          }
        }
      }
    } catch (e) {
      dev = { attempted: true, ok: false, reason: e?.message || 'dev write failed' };
    }

    return NextResponse.json({
      url: finalUrl,
      replaced: !!prodEp.s3_url,
      previous: prodEp.s3_url || null,
      prod: { ok: true },
      dev,
    });
  } catch (err) {
    console.error('[POST /api/uploads/sync]', err);
    return NextResponse.json({ error: err.message || 'sync failed' }, { status: 500 });
  }
}
