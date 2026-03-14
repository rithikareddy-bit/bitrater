import { NextResponse } from 'next/server';
import { BatchClient, ListJobsCommand } from '@aws-sdk/client-batch';
import clientPromise from '@/lib/mongodb';
import { TOTAL_JOBS } from '@/lib/constants';

const batch = new BatchClient({ region: process.env.AWS_REGION || 'us-east-1' });

const JOB_QUEUE = process.env.BATCH_JOB_QUEUE || 'chai-q-queue';
const STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING'];

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');
    const episode = await db.collection('video_episodes').findOne(
      { episode_id: id },
      { projection: { lab_run_started_at: 1, lab_status: 1 } },
    );
    const runStartedAt = episode?.lab_run_started_at
      ? new Date(episode.lab_run_started_at).getTime()
      : null;

    const counts = { SUBMITTED: 0, PENDING: 0, RUNNABLE: 0, STARTING: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 };

    if (runStartedAt != null) {
      await Promise.all(
        STATUSES.map(async (status) => {
          const cmd = new ListJobsCommand({ jobQueue: JOB_QUEUE, jobStatus: status });
          const resp = await batch.send(cmd);
          const matching = (resp.jobSummaryList || []).filter(
            (j) =>
              j.jobName &&
              j.jobName.includes(id) &&
              j.createdAt >= runStartedAt
          );
          counts[status] = matching.length;
        })
      );
    }

    const total = TOTAL_JOBS;
    const succeeded = counts.SUCCEEDED;
    const failed = counts.FAILED;
    const running = counts.RUNNING + counts.STARTING;
    const labStatus = episode?.lab_status || null;

    return NextResponse.json({ total, succeeded, failed, running, counts, labStatus });
  } catch (err) {
    console.error('[GET /api/status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch job status' }, { status: 500 });
  }
}
