import { getDevClientPromise } from '@/lib/mongodb';

const DB = process.env.MONGO_DATABASE || 'master';
const SHOWCACHE = process.env.MONGO_SHOWCACHE_COLLECTION || 'showcache';

// Try the showcache lookup against prod; if no s3_url is found, retry against
// the dev cluster (SUBTITLE_MONGO_URI). Returns the showcache doc shape
// `{ ...projection }` or null when neither side has it.
async function withFallback(masterDb, runQuery, hasS3Url) {
  const primary = await runQuery(masterDb);
  if (hasS3Url(primary)) return primary;

  const devPromise = getDevClientPromise();
  if (!devPromise) return primary;
  try {
    const devClient = await devPromise;
    const devDb = devClient.db(DB);
    const fallback = await runQuery(devDb);
    if (hasS3Url(fallback)) return fallback;
    return primary || fallback;
  } catch (err) {
    console.error('[showcacheLookup] dev fallback failed:', err);
    return primary;
  }
}

export function findEpisodeInShowcache(masterDb, episodeId, projection = { 'episodes.$': 1 }) {
  return withFallback(
    masterDb,
    (db) => db.collection(SHOWCACHE).findOne(
      { 'episodes.id': episodeId },
      { projection },
    ),
    (doc) => !!doc?.episodes?.[0]?.s3_url,
  );
}

export function findTrailerInShowcase(masterDb, showObjectId, trailerKey, projection = { 'trailers_playback_urls.$': 1 }) {
  return withFallback(
    masterDb,
    (db) => db.collection(SHOWCACHE).findOne(
      { _id: showObjectId, 'trailers_playback_urls._key': trailerKey },
      { projection },
    ),
    (doc) => {
      const t = doc?.trailers_playback_urls?.[0];
      return !!(t?.s3Url || t?.s3_url);
    },
  );
}
