import { NextResponse } from 'next/server';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

const SFN_TERMINAL_STATES = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

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
          gcp_execution_arn: 1,
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

    let gcpStatus = episode.gcp_job_status || null;
    let gcpError = episode.gcp_error || null;

    if (
      (gcpStatus === 'PENDING' || gcpStatus === 'RUNNING') &&
      episode.gcp_execution_arn
    ) {
      try {
        const desc = await sfn.send(
          new DescribeExecutionCommand({ executionArn: episode.gcp_execution_arn }),
        );
        if (SFN_TERMINAL_STATES.has(desc.status)) {
          gcpStatus = 'FAILED';
          gcpError = `Step Function ${desc.status}${desc.cause ? `: ${desc.cause}` : ''}`;
          await db.collection('video_episodes').updateOne(
            { episode_id: id },
            {
              $set: {
                gcp_job_status: 'FAILED',
                gcp_error: gcpError,
                gcp_finished_at: new Date().toISOString(),
              },
            },
          );
        }
      } catch {
        // If we can't reach SFN, just return the stored status
      }
    }

    return NextResponse.json({
      gcp_job_status: gcpStatus,
      gcp_job_name: episode.gcp_job_name || null,
      gcp_started_at: episode.gcp_started_at || null,
      gcp_finished_at: episode.gcp_finished_at || null,
      gcp_error: gcpError,
      h264_master_m3u8_url: episode.h264_master_m3u8_url || null,
      h265_master_m3u8_url: episode.h265_master_m3u8_url || null,
    });
  } catch (err) {
    console.error('[GET /api/gcp-status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch GCP status' }, { status: 500 });
  }
}
