import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { LEGACY_TOTAL_JOBS_H264, LEGACY_TOTAL_JOBS_H265 } from '@/lib/constants';

export async function GET(request, { params }) {
  const { id } = params;
  const { searchParams } = new URL(request.url);
  const codecParam = searchParams.get('codec');

  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: id },
      {
        projection: {
          lab_status_h264: 1,
          lab_status_h265: 1,
          lab_run_started_at_h264: 1,
          lab_run_started_at_h265: 1,
          search_progress_h264: 1,
          search_progress_h265: 1,
        },
      }
    );

    const buildCodecStatus = async (codec) => {
      const libCodec = codec === 'h264' ? 'libx264' : 'libx265';
      const legacyTotal = codec === 'h264' ? LEGACY_TOTAL_JOBS_H264 : LEGACY_TOTAL_JOBS_H265;
      const labStatus = episode?.[`lab_status_${codec}`] ?? null;
      const searchProgress = episode?.[`search_progress_${codec}`] ?? null;

      const succeeded = await db.collection('video_vmaf_research').countDocuments({
        episode_id: id,
        codec: libCodec,
      });

      let total = legacyTotal;
      let failed = 0;
      let running = 0;
      let resolutionPhases = null;

      if (searchProgress?.resolutions && labStatus !== 'FAILED') {
        const resolutionEntries = Object.entries(searchProgress.resolutions);
        resolutionPhases = {};

        let testedFromProgress = 0;
        let pendingFromProgress = 0;
        for (const [resolution, detail] of resolutionEntries) {
          const tested = Number(detail?.tested || 0);
          const pending = Number(detail?.pending || 0);
          testedFromProgress += tested;
          pendingFromProgress += pending;
          resolutionPhases[resolution] = {
            phase: detail?.phase || 'PROBING',
            rawPhase: detail?.raw_phase || null,
            tested,
            pending,
            winner: detail?.winner ?? null,
            bracketDisplay: detail?.bracket_display ?? null,
            message: detail?.message ?? null,
          };
        }

        total = Math.max(0, testedFromProgress + pendingFromProgress);
        running = pendingFromProgress;
        failed = Math.max(0, total - running - testedFromProgress);
      } else if (labStatus === 'FAILED') {
        failed = Math.max(0, total - succeeded);
      } else if (labStatus === 'RUNNING') {
        running = Math.max(0, total - succeeded);
      }

      return {
        total,
        succeeded,
        failed,
        running,
        labStatus,
        pollCount: searchProgress?.poll_count ?? null,
        allDone: searchProgress?.all_done ?? null,
        resolutionPhases,
      };
    };

    if (codecParam === 'h264' || codecParam === 'h265') {
      const data = await buildCodecStatus(codecParam);
      return NextResponse.json(data);
    }

    const [h264, h265] = await Promise.all([
      buildCodecStatus('h264'),
      buildCodecStatus('h265'),
    ]);
    return NextResponse.json({ h264, h265 });
  } catch (err) {
    console.error('[GET /api/status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch job status' }, { status: 500 });
  }
}
