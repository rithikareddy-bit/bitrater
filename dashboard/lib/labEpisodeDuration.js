/**
 * Server-only: resolve episode duration the same way for UI (GET /api/episode)
 * and show catalog sync (POST /api/sync-showcache-episode).
 */

/**
 * @param {import('mongodb').Db} labDb chai_q_lab
 * @param {string} episodeId
 * @returns {Promise<number>}
 */
export async function maxVmafTimelineSeconds(labDb, episodeId) {
  const agg = await labDb
    .collection('video_vmaf_research')
    .aggregate([
      { $match: { episode_id: episodeId } },
      {
        $project: {
          tl: { $size: { $ifNull: ['$vmaf_timeline', []] } },
        },
      },
      { $group: { _id: null, max: { $max: '$tl' } } },
    ])
    .toArray();
  return Number(agg[0]?.max) || 0;
}

/**
 * Prefer showcache episode.duration; else max VMAF timeline length across all research docs.
 *
 * @param {import('mongodb').Db} labDb
 * @param {object | null} episodeMeta from showcache
 * @param {string} episodeId
 * @returns {Promise<{ durationSeconds: number, durationSource: string }>}
 */
export async function resolveDurationForLabEpisode(labDb, episodeMeta, episodeId) {
  const d = episodeMeta?.duration;
  if (d != null && Number(d) > 0) {
    return { durationSeconds: Number(d), durationSource: 'showcache' };
  }
  const tl = await maxVmafTimelineSeconds(labDb, episodeId);
  return {
    durationSeconds: tl,
    durationSource: tl > 0 ? 'vmaf_timeline' : 'unknown',
  };
}
