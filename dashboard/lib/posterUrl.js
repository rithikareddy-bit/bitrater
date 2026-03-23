const POSTER_SIZE_ORDER = ['mediumPoster', 'largePoster', 'smallPoster'];

/**
 * First URL from showcache `s3_primary_poster_ids` (locale → first array item → poster fields).
 */
export function posterUrlFromS3PrimaryPosterIds(s3) {
  if (!s3 || typeof s3 !== 'object') return null;
  const locales = Object.keys(s3).sort();
  for (const loc of locales) {
    const arr = s3[loc];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const first = arr[0];
    if (!first || typeof first !== 'object') continue;
    for (const key of POSTER_SIZE_ORDER) {
      const u = first[key];
      if (typeof u === 'string' && u.trim()) return u.trim();
    }
    for (const u of Object.values(first)) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return u.trim();
    }
  }
  return null;
}

/**
 * Best poster/thumbnail URL for catalog cards.
 */
export function resolveShowPosterUrl(show) {
  if (!show) return null;
  const fromS3 = posterUrlFromS3PrimaryPosterIds(show.s3_primary_poster_ids);
  if (fromS3) return fromS3;
  if (typeof show.thumbnail === 'string' && show.thumbnail.trim()) return show.thumbnail.trim();
  if (typeof show.s3_primary_poster_id === 'string' && show.s3_primary_poster_id.trim()) {
    return show.s3_primary_poster_id.trim();
  }
  if (typeof show.preview_gif === 'string' && show.preview_gif.trim()) return show.preview_gif.trim();
  return null;
}