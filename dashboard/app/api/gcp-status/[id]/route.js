import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: id },
      {
        projection: {
          gcp_job_status: 1,
          gcp_job_name: 1,
          gcp_started_at: 1,
          gcp_finished_at: 1,
          gcp_error: 1,
          h264_master_m3u8_url: 1,
          h265_master_m3u8_url: 1,
        },
      },
    );

    if (!episode) {
      return NextResponse.json({ gcp_job_status: null });
    }

    return NextResponse.json({
      gcp_job_status: episode.gcp_job_status || null,
      gcp_job_name: episode.gcp_job_name || null,
      gcp_started_at: episode.gcp_started_at || null,
      gcp_finished_at: episode.gcp_finished_at || null,
      gcp_error: episode.gcp_error || null,
      h264_master_m3u8_url: episode.h264_master_m3u8_url || null,
      h265_master_m3u8_url: episode.h265_master_m3u8_url || null,
    });
  } catch (err) {
    console.error('[GET /api/gcp-status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch GCP status' }, { status: 500 });
  }
}
