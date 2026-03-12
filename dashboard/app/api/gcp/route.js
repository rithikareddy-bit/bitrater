import { NextResponse } from 'next/server';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function POST(request) {
  try {
    const { episodeId } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const gcpSfnArn = process.env.GCP_SFN_ARN;
    if (!gcpSfnArn) {
      return NextResponse.json({ error: 'GCP_SFN_ARN not configured' }, { status: 500 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const episode = await labDb.collection('video_episodes').findOne({ episode_id: episodeId });

    if (episode?.gcp_job_status === 'RUNNING' || episode?.gcp_job_status === 'PENDING') {
      return NextResponse.json(
        { error: 'A GCP job is already active for this episode' },
        { status: 409 },
      );
    }

    const goldenRecipes = episode?.golden_recipes;
    if (!goldenRecipes?.resolutions) {
      return NextResponse.json({ error: 'Lab results (golden_recipes) not found' }, { status: 400 });
    }

    const resolutions = goldenRecipes.resolutions;
    for (const res of ['1080p', '720p', '480p']) {
      if (!resolutions[res]?.h264 || !resolutions[res]?.h265) {
        return NextResponse.json(
          { error: `Incomplete lab results for ${res} — both H.264 and H.265 winners required` },
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

    await labDb.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          gcp_job_status: 'PENDING',
          gcp_started_at: new Date().toISOString(),
          gcp_error: null,
          gcp_finished_at: null,
          gcp_job_name: null,
        },
        $unset: {
          h264_master_m3u8_url: '',
          h265_master_m3u8_url: '',
        },
      },
    );

    const input = JSON.stringify({
      episode_id: episodeId,
      s3_url: s3Url,
      golden_recipes: goldenRecipes,
    });

    const cmd = new StartExecutionCommand({ stateMachineArn: gcpSfnArn, input });
    const result = await sfn.send(cmd);

    return NextResponse.json({ executionArn: result.executionArn });
  } catch (err) {
    console.error('[POST /api/gcp]', err);
    return NextResponse.json({ error: 'Failed to start GCP pipeline' }, { status: 500 });
  }
}
