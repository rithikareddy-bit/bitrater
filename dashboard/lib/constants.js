export const TOTAL_JOBS = 21; // legacy single pipeline

// Initial probe counts per codec (used as progress denominator before search_progress is written)
// H264: 1080p(3) + 720p(2) + 480p(1) = 6
// H265: 1080p(3) + 720p(2) + 480p(1) = 6
export const LEGACY_TOTAL_JOBS_H264 = 6;
export const LEGACY_TOTAL_JOBS_H265 = 6;

export const INITIAL_PROBES_H264 = 6; // 1080p(3) + 720p(2) + 480p(1)
export const INITIAL_PROBES_H265 = 6; // 1080p(3) + 720p(2) + 480p(1)

// Single source of truth for VMAF quality thresholds per resolution
export const VMAF_THRESHOLDS = { '1080p': 88, '720p': 75, '480p': 48 };
