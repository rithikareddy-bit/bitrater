import { NextResponse } from 'next/server';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';
import { videoIdFromS3Url } from '@/lib/videoId';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

const SFN_TERMINAL_STATES = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

async function resolveCodecStatus(db, episodeId, episode, codec) {
  const statusKey = `gcp_job_status_${codec}`;
  const execArnKey = `gcp_execution_arn_${codec}`;
  const startedAtKey = `gcp_started_at_${codec}`;
  const finishedAtKey = `gcp_finished_at_${codec}`;
  const errorKey = `gcp_error_${codec}`;
  const jobNameKey = `gcp_job_name_${codec}`;

  let gcpStatus = episode[statusKey] || null;
  let gcpError = episode[errorKey] || null;

  if (
    (gcpStatus === 'PENDING' || gcpStatus === 'RUNNING') &&
    episode[execArnKey]
  ) {
    try {
      const desc = await sfn.send(
        new DescribeExecutionCommand({ executionArn: episode[execArnKey] }),
      );
      if (SFN_TERMINAL_STATES.has(desc.status)) {
        gcpStatus = 'FAILED';
        gcpError = `Step Function ${desc.status}${desc.cause ? `: ${desc.cause}` : ''}`;
        await db.collection('video_episodes').updateOne(
          { episode_id: episodeId },
          {
            $set: {
              [statusKey]: 'FAILED',
              [errorKey]: gcpError,
              [finishedAtKey]: new Date().toISOString(),
            },
          },
        );
      }
    } catch {
      // If we can't reach SFN, just return the stored status
    }
  }

  return {
    gcp_job_status: gcpStatus,
    gcp_job_name: episode[jobNameKey] || null,
    gcp_started_at: episode[startedAtKey] || null,
    gcp_finished_at: episode[finishedAtKey] || null,
    gcp_error: gcpError,
  };
}

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');
    const masterDb = client.db(process.env.MONGO_DATABASE || 'master');
    const vttCollection = process.env.MONGO_VTT_COLLECTION || 'episode_vtt';

    const projection = {
      h264_master_m3u8_url: 1,
      h265_master_m3u8_url: 1,
      combined_master_m3u8_url: 1,
    };
    for (const codec of ['h264', 'h265']) {
      projection[`gcp_job_status_${codec}`] = 1;
      projection[`gcp_execution_arn_${codec}`] = 1;
      projection[`gcp_started_at_${codec}`] = 1;
      projection[`gcp_finished_at_${codec}`] = 1;
      projection[`gcp_error_${codec}`] = 1;
      projection[`gcp_job_name_${codec}`] = 1;
    }

    let thumb_vtt = null;
    try {
      const showWithEp = await masterDb.collection('showcache').findOne(
        { 'episodes.id': id },
        { projection: { 'episodes.$': 1 } },
      );
      const s3Url = showWithEp?.episodes?.[0]?.s3_url;
      if (s3Url) {
        const videoId = videoIdFromS3Url(s3Url);
        if (videoId) {
          const vttDoc = await masterDb.collection(vttCollection).findOne(
            { video_id: videoId },
            { projection: { vtt_url: 1, sprite_url: 1 } },
          );
          if (vttDoc) {
            thumb_vtt = {
              vtt_url: vttDoc.vtt_url || null,
              sprite_url: vttDoc.sprite_url || null,
            };
          }
        }
      }
    } catch {
      thumb_vtt = null;
    }

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: id },
      { projection },
    );

    if (!episode) {
      return NextResponse.json({ h264: null, h265: null, thumb_vtt });
    }

    const [h264, h265] = await Promise.all([
      resolveCodecStatus(db, id, episode, 'h264'),
      resolveCodecStatus(db, id, episode, 'h265'),
    ]);

    return NextResponse.json({
      h264,
      h265,
      h264_master_m3u8_url: episode.h264_master_m3u8_url || null,
      h265_master_m3u8_url: episode.h265_master_m3u8_url || null,
      combined_master_m3u8_url: episode.combined_master_m3u8_url || null,
      thumb_vtt,
    });
  } catch (err) {
    console.error('[GET /api/gcp-status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch GCP status' }, { status: 500 });
  }
}
