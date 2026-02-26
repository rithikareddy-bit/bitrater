import { NextResponse } from 'next/server';
import { BatchClient, ListJobsCommand } from '@aws-sdk/client-batch';

const batch = new BatchClient({ region: process.env.AWS_REGION || 'us-east-1' });

const JOB_QUEUE = process.env.BATCH_JOB_QUEUE || 'chai-q-lab-queue';
const STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING'];

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const counts = { SUBMITTED: 0, PENDING: 0, RUNNABLE: 0, STARTING: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 };

    await Promise.all(
      STATUSES.map(async (status) => {
        const cmd = new ListJobsCommand({ jobQueue: JOB_QUEUE, jobStatus: status });
        const resp = await batch.send(cmd);
        // Filter jobs that belong to this episode by name prefix convention
        const matching = (resp.jobSummaryList || []).filter(
          (j) => j.jobName && j.jobName.includes(id)
        );
        counts[status] = matching.length;
      })
    );

    const total = 7; // H.265×4 + H.264×3
    const succeeded = counts.SUCCEEDED;
    const failed = counts.FAILED;
    const running = counts.RUNNING + counts.STARTING;

    return NextResponse.json({ total, succeeded, failed, running, counts });
  } catch (err) {
    console.error('[GET /api/status/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch job status' }, { status: 500 });
  }
}
