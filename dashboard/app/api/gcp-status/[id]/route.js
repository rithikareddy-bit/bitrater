import { NextResponse } from 'next/server';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';
import { videoIdFromS3Url } from '@/lib/videoId';
import { findEpisodeInShowcache } from '@/lib/showcacheLookup';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

const SFN_TERMINAL_STATES = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

// `pfx` selects the field namespace: '' for the classic Lab/GCP run,
// 'av_' for a run started from the Audio-Video page. The two sets are kept
// apart so neither overwrites the other's status or master URLs.
async function resolveCodecStatus(db, episodeId, episode, codec, pfx = '') {
  const statusKey = `${pfx}gcp_job_status_${codec}`;
  const execArnKey = `${pfx}gcp_execution_arn_${codec}`;
  const startedAtKey = `${pfx}gcp_started_at_${codec}`;
  const finishedAtKey = `${pfx}gcp_finished_at_${codec}`;
  const errorKey = `${pfx}gcp_error_${codec}`;
  const jobNameKey = `${pfx}gcp_job_name_${codec}`;

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
      podcastvideo_m3u8_url: 1,
    };
    projection.av_h264_master_m3u8_url = 1;
    projection.av_h265_master_m3u8_url = 1;
    for (const codec of ['h264', 'h265']) {
      for (const pfx of ['', 'av_']) {
        projection[`${pfx}gcp_job_status_${codec}`] = 1;
        projection[`${pfx}gcp_execution_arn_${codec}`] = 1;
        projection[`${pfx}gcp_started_at_${codec}`] = 1;
        projection[`${pfx}gcp_finished_at_${codec}`] = 1;
        projection[`${pfx}gcp_error_${codec}`] = 1;
        projection[`${pfx}gcp_job_name_${codec}`] = 1;
      }
    }

    let thumb_vtt = null;
    try {
      const showWithEp = await findEpisodeInShowcache(masterDb, id);
      const s3Url = showWithEp?.episodes?.[0]?.s3_url;
      if (s3Url) {
        const videoId = videoIdFromS3Url(s3Url);
        if (videoId) {
          const vttDoc = await masterDb.collection(vttCollection).findOne(
            { video_id: videoId },
            { projection: { vtt_url: 1, sprite_url: 1, updated_at: 1 } },
          );
          if (vttDoc) {
            thumb_vtt = {
              vtt_url: vttDoc.vtt_url || null,
              sprite_url: vttDoc.sprite_url || null,
              updated_at: vttDoc.updated_at || null,
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

    const [h264, h265, avH264, avH265] = await Promise.all([
      resolveCodecStatus(db, id, episode, 'h264'),
      resolveCodecStatus(db, id, episode, 'h265'),
      resolveCodecStatus(db, id, episode, 'h264', 'av_'),
      resolveCodecStatus(db, id, episode, 'h265', 'av_'),
    ]);

    return NextResponse.json({
      // Classic Lab/GCP run — unchanged shape for every existing consumer.
      h264,
      h265,
      h264_master_m3u8_url: episode.h264_master_m3u8_url || null,
      h265_master_m3u8_url: episode.h265_master_m3u8_url || null,
      combined_master_m3u8_url: episode.combined_master_m3u8_url || null,
      // Audio-Video run — its own status and masters.
      av: {
        h264: avH264,
        h265: avH265,
        h264_master_m3u8_url: episode.av_h264_master_m3u8_url || null,
        h265_master_m3u8_url: episode.av_h265_master_m3u8_url || null,
      },
      podcastvideo_m3u8_url: episode.podcastvideo_m3u8_url || null,
      thumb_vtt,
    });
  } catch (err) {
    console.error('[GET /api/gcp-status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch GCP status' }, { status: 500 });
  }
}
