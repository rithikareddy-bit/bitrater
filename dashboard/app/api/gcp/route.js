import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId, codec } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const gcpSfnArn = process.env.GCP_SFN_ARN;
    if (!gcpSfnArn) {
      return NextResponse.json({ error: 'GCP_SFN_ARN not configured' }, { status: 500 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const episode = await labDb.collection('video_episodes').findOne({ episode_id: episodeId });

    const statusKey = `gcp_job_status_${codec}`;
    const status = episode?.[statusKey];
    if (status === 'RUNNING' || status === 'PENDING') {
      return NextResponse.json(
        { error: `A GCP ${codec.toUpperCase()} job is already active for this episode` },
        { status: 409 },
      );
    }

    const goldenRecipes = episode?.golden_recipes;
    if (!goldenRecipes?.resolutions) {
      return NextResponse.json({ error: 'Lab results (golden_recipes) not found' }, { status: 400 });
    }

    const resolutions = goldenRecipes.resolutions;
    for (const res of ['1080p', '720p', '480p']) {
      const recipe = resolutions[res]?.[codec];
      if (!recipe) {
        return NextResponse.json(
          { error: `Missing ${codec.toUpperCase()} golden recipe for ${res} — run the lab first` },
          { status: 400 },
        );
      }
    }

    const showWithEp = await masterDb.collection('showcache').findOne(
      { 'episodes.id': episodeId },
      { projection: { 'episodes.$': 1 } },
    );
    const s3Url = showWithEp?.episodes?.[0]?.s3_url;
    if (!s3Url) {
      return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
    }

    const urlKey = codec === 'h264' ? 'h264_master_m3u8_url' : 'h265_master_m3u8_url';
    const execArnKey = `gcp_execution_arn_${codec}`;
    const startedAtKey = `gcp_started_at_${codec}`;
    const errorKey = `gcp_error_${codec}`;
    const finishedAtKey = `gcp_finished_at_${codec}`;
    const jobNameKey = `gcp_job_name_${codec}`;
    const now = new Date().toISOString();

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          [statusKey]: 'PENDING',
          [startedAtKey]: now,
          [execArnKey]: null,
          [errorKey]: null,
          [finishedAtKey]: null,
          [jobNameKey]: null,
        },
        $unset: { [urlKey]: '', gcp_subtitle_error: '' },
      },
    );

    const input = JSON.stringify({
      episode_id: episodeId,
      s3_url: s3Url,
      golden_recipes: goldenRecipes,
      codec,
    });

    let result;
    try {
      const cmd = new StartExecutionCommand({ stateMachineArn: gcpSfnArn, input });
      result = await sfn.send(cmd);
    } catch (sfnErr) {
      await labDb.collection('video_episodes').updateOne(
        { episode_id: episodeId },
        {
          $set: {
            [statusKey]: 'FAILED',
            [errorKey]: sfnErr.message || 'Failed to start Step Function',
            [finishedAtKey]: new Date().toISOString(),
          },
        },
      );
      throw sfnErr;
    }

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { [execArnKey]: result.executionArn } },
    );

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/gcp]', err);
    return NextResponse.json({ error: 'Failed to start GCP pipeline' }, { status: 500 });
  }
}
