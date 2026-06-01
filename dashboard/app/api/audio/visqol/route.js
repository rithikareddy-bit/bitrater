import { NextResponse } from 'next/server';
import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch';
import clientPromise from '@/lib/mongodb';

const region = process.env.AWS_REGION || 'us-east-1';
const batch = new BatchClient({ region });

export const dynamic = 'force-dynamic';

// POST /api/audio/visqol  { episodeId }
// Submit a ViSQOL "Check Quality" job (AWS Batch) that scores the already-encoded
// 64k HE-AAC rendition of one episode against its source. Measurement-only — no
// re-transcode, no GCP creds (both inputs are public HTTPS). Mirrors convert/route.js
// but SubmitJob instead of StartExecution.
export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });

    const jobQueue = process.env.BATCH_JOB_QUEUE;
    const jobDefinition = process.env.AUDIO_VISQOL_JOB_DEFINITION;
    if (!jobQueue || !jobDefinition) {
      return NextResponse.json(
        { error: 'BATCH_JOB_QUEUE / AUDIO_VISQOL_JOB_DEFINITION not configured' },
        { status: 500 },
      );
    }

    const client = await clientPromise();

    // The public master to score — written best-effort by gcp_check_audio_status on SUCCEEDED.
    // If it's empty, publish hasn't run and the worker can't fetch the renditions over HTTPS;
    // reject with a clear message rather than submit a job doomed to fail (Gap G1 in the plan).
    const lab = client.db('chai_q_lab');
    const status = await lab
      .collection('audio_episodes')
      .findOne({ episode_id: episodeId }, { projection: { public_master_url: 1 } });
    const masterUrl = status?.public_master_url;
    if (!masterUrl) {
      return NextResponse.json(
        { error: 'No public master yet — run the audio pipeline and let the public copy finish first.' },
        { status: 409 },
      );
    }

    // The source master (podcast audio_url) lives in podcast_showcache.
    const show = await client
      .db('master')
      .collection('podcast_showcache')
      .findOne({ 'episodes.id': episodeId }, { projection: { 'episodes.$': 1 } });
    const sourceUrl = show?.episodes?.[0]?.audio_url;
    if (!sourceUrl) {
      return NextResponse.json({ error: 'episode or source audio_url not found' }, { status: 404 });
    }

    // Stamp CALCULATING so the dashboard shows a spinner immediately (the worker flips it to
    // DONE/FAILED). Records computed_at so a stale CALCULATING can be detected if the container
    // is OOM-killed before it can self-stamp (Gap G7).
    await lab.collection('audio_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { visqol: { status: 'CALCULATING', computed_at: new Date().toISOString(), error: null } } },
      { upsert: true },
    );

    const res = await batch.send(
      new SubmitJobCommand({
        jobName: `audio-visqol-${episodeId.slice(0, 30).replace(/[^a-zA-Z0-9-_]/g, '-')}-${Date.now()}`,
        jobQueue,
        jobDefinition,
        containerOverrides: {
          environment: [
            { name: 'EPISODE_ID', value: episodeId },
            { name: 'MASTER_URL', value: masterUrl },
            { name: 'SOURCE_URL', value: sourceUrl },
          ],
        },
      }),
    );

    // Record the Batch job id for debugging a stuck CALCULATING (Gap G7).
    await lab.collection('audio_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { 'visqol.batch_job_id': res.jobId } },
    );

    return NextResponse.json({ ok: true, jobId: res.jobId });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
