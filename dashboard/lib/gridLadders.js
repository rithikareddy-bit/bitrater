// Work units for the "Parallel Resol" lab.
//
// One unit == one Batch job == one worker == one (episode, resolution, codec).
// The worker runs the FULL binary search over that resolution's bitrate ladder
// INTERNALLY (research-worker/worker.py) and writes the trials to
// video_vmaf_research; the aggregator then picks the winner. So an episode is
// 6 units (3 resolutions x 2 codecs), not 47 single-bitrate encodes — the
// binary search is kept, just parallelised across the 6 resolution/codec units
// that the serial lab otherwise walks one at a time.

// codec key -> ffmpeg library name (the CODEC env the worker reads, and the
// `codec` value written to video_vmaf_research).
export const CODEC_LIB = { h264: 'libx264', h265: 'libx265' };

// VMAF pass thresholds per resolution (aggregator.py VMAF_THRESHOLDS). Kept here
// for reference; the actual thresholds/ladders live in the worker + aggregator.
export const VMAF_THRESHOLDS = { '1080p': 88, '720p': 75, '480p': 48 };

// Candidate bitrate ladders per codec/resolution — 1:1 mirror of SEARCH_CONFIG
// in research-worker/worker.py. Used by the episode-page "Bitrate Resol" engine,
// which launches ONE single-bitrate worker per candidate (not a binary search).
// Keep in sync with worker.py if the ladders change.
export const BITRATE_LADDERS = {
  h264: {
    '1080p': [1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200, 4400, 4600, 4800],
    '720p':  [700, 900, 1100, 1300, 1500, 1700, 1900],
    '480p':  [200, 300, 400, 500, 600],
  },
  h265: {
    '1080p': [800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200],
    '720p':  [500, 700, 900, 1200, 1350, 1500, 1650],
    '480p':  [100, 200, 300, 400, 500],
  },
};

// Resolution processing order (highest first — longest searches started earliest).
export const RESOLUTION_ORDER = ['1080p', '720p', '480p'];

// Each codec is searched at 3 resolutions -> 3 units per (episode, codec).
export const RESOLUTIONS_PER_CODEC = RESOLUTION_ORDER.length;

// RESOLUTION env value the worker expects ("1080p" -> "1080").
export function resolutionEnvValue(resolutionTag) {
  return resolutionTag.replace('p', '');
}

// Build the ordered list of search units for one episode (both codecs).
// Order within an episode: resolution-major (1080p -> 720p -> 480p), then codec.
function episodeUnits(ep, codecs) {
  const units = [];
  for (const res of RESOLUTION_ORDER) {
    for (const codec of codecs) {
      units.push({
        episode_id: String(ep.id ?? ep.episode_id),
        s3_url: ep.s3_url,
        codec, // 'h264' | 'h265'
        codec_lib: CODEC_LIB[codec], // 'libx264' | 'libx265' (the CODEC env)
        resolution: res, // '1080p'
        resolution_env: resolutionEnvValue(res), // '1080'
      });
    }
  }
  return units;
}

// Flatten a set of episodes into one work-conserving queue of search units.
//
// Ordering = round-robin ACROSS episodes (breadth-first), resolution-major
// WITHIN each episode. So the first N units are the first unit of each of the N
// episodes, guaranteeing all episodes start progressing at once. The pool stays
// full regardless of ordering; this only controls which episodes finish first.
export function buildUnitQueue(episodes, codecs = ['h264', 'h265']) {
  const perEpisode = episodes
    .filter((ep) => (ep.s3_url || '').trim() !== '')
    .map((ep) => episodeUnits(ep, codecs));

  const queue = [];
  const maxLen = perEpisode.reduce((m, list) => Math.max(m, list.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of perEpisode) {
      if (i < list.length) queue.push(list[i]);
    }
  }
  return queue;
}

// Number of units for one episode-codec = number of resolutions searched (3).
export function unitsPerCodec() {
  return RESOLUTIONS_PER_CODEC;
}

// Unique key for one search unit.
export function unitKey(unit) {
  return `${unit.episode_id}|${unit.codec}|${unit.resolution}`;
}

// Unique key for a (episode, codec) grid — the aggregation unit (3 resolutions).
export function gridKey(episodeId, codec) {
  return `${episodeId}|${codec}`;
}
