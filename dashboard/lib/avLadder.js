/**
 * Audio-Video ladder — the 4-rung ladder used by the /audio-video page.
 *
 * Unlike the classic catalog flow, these bitrates are entered by hand (no Lab,
 * no VMAF search). The defaults below are the agreed starting table; the page
 * writes whatever is in the inputs into `chai_q_lab.video_episodes.golden_recipes`
 * in exactly the shape the Lab would have produced, so every downstream step
 * (GCP transcode → finalize → combined master → subtitles → sync) is unchanged.
 */

/** Playlist order: 144p first, then the classic 720→480→1080 sequence.
 *  Also drives the row order of the bitrate table on the page. */
export const AV_RESOLUTIONS = ['144p', '720p', '480p', '1080p'];

/** kbps, per resolution per codec. */
export const AV_DEFAULT_BITRATES = {
  '144p':  { h264: 220,  h265: 120 },
  '720p':  { h264: 2500, h265: 1500 },
  '480p':  { h264: 1200, h265: 650 },
  '1080p': { h264: 5000, h265: 4000 },
};

/**
 * Is this recipe an Audio-Video ladder?
 *
 * Derived from the recipe itself — the `ladder` marker the page writes, or the
 * presence of the 144p rung — never from a stored flag. That way anything which
 * replaces golden_recipes wholesale (a Lab run, the classic defaults button)
 * automatically stops looking like an Audio-Video ladder, instead of leaving a
 * stale boolean behind. Mirrors `_is_audio_video_ladder` in gcp_transcoder.py.
 */
export function isAudioVideoRecipe(goldenRecipes) {
  if (!goldenRecipes) return false;
  if (goldenRecipes.ladder === 'audio_video') return true;
  return Boolean(goldenRecipes.resolutions?.['144p']);
}

/** Empty input state — every rung blank, so nothing is submitted by accident. */
export function emptyBitrates() {
  return Object.fromEntries(
    AV_RESOLUTIONS.map((res) => [res, { h264: '', h265: '' }]),
  );
}

/** Default table as input state (strings, since it feeds <input> values). */
export function defaultBitrates() {
  return Object.fromEntries(
    AV_RESOLUTIONS.map((res) => [
      res,
      {
        h264: String(AV_DEFAULT_BITRATES[res].h264),
        h265: String(AV_DEFAULT_BITRATES[res].h265),
      },
    ]),
  );
}

/** golden_recipes.resolutions → input state, for reloading a saved ladder. */
export function bitratesFromGoldenRecipes(goldenRecipes) {
  const resolutions = goldenRecipes?.resolutions || {};
  return Object.fromEntries(
    AV_RESOLUTIONS.map((res) => [
      res,
      {
        h264: resolutions[res]?.h264?.bitrate_kbps != null
          ? String(resolutions[res].h264.bitrate_kbps) : '',
        h265: resolutions[res]?.h265?.bitrate_kbps != null
          ? String(resolutions[res].h265.bitrate_kbps) : '',
      },
    ]),
  );
}

/** Human-readable kbps → "1.2 Mbps" / "220 kbps". */
export function formatKbps(kbps) {
  const n = Number(kbps);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} Mbps`;
  return `${n} kbps`;
}
