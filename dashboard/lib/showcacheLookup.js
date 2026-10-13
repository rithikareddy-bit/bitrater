import { getDevClientPromise } from '@/lib/mongodb';

const DB = process.env.MONGO_DATABASE || 'master';
const SHOWCACHE = process.env.MONGO_SHOWCACHE_COLLECTION || 'showcache';
const PODCAST_SHOWCACHE = 'podcast_showcache';

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

// Podcast episodes live in podcast_showcache with their own UUIDs (no overlap
// with showcache ids), and the Audio-Video page runs them through the same
// GCP/VTT routes — so a showcache miss also checks podcast_showcache.
export function findEpisodeInShowcache(masterDb, episodeId, projection = { 'episodes.$': 1 }) {
  const hasS3Url = (doc) => !!doc?.episodes?.[0]?.s3_url;
  return withFallback(
    masterDb,
    async (db) => {
      const show = await db.collection(SHOWCACHE).findOne(
        { 'episodes.id': episodeId },
        { projection },
      );
      if (hasS3Url(show)) return show;
      const podcast = await db.collection(PODCAST_SHOWCACHE).findOne(
        { 'episodes.id': episodeId },
        { projection },
      );
      return hasS3Url(podcast) ? podcast : show || podcast;
    },
    hasS3Url,
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
