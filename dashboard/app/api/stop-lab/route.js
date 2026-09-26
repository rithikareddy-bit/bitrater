import { NextResponse } from 'next/server';
import { stopWorkflow } from '@/lib/workflows';
import { listActiveJobs, terminateJob } from '@/lib/jobs';
import clientPromise from '@/lib/mongodb';
import { DB_LAB } from '@/lib/config';

const BATCH_STATUSES = ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'];

async function terminateOrphanedBatchJobs(episodeId) {
  // Serial lab jobs: ChaiQSearch-{id[:24]}-. Parallel Resol jobs (episode-page
  // "Run lab · Resol"): ParallelResol-{id[:20]}-. Match both so Stop kills either.
  const prefixes = [
    `ChaiQSearch-${episodeId.slice(0, 24)}-`,
    `ParallelResol-${episodeId.slice(0, 20)}-`,
  ];
  // AWS queue (if configured) plus the Azure Batch lab job (if configured).
  const jobs = await listActiveJobs('lab', { jobQueue: process.env.BATCH_JOB_QUEUE, statuses: BATCH_STATUSES });

  let terminated = 0;
  for (const job of jobs) {
    if (job.jobName && prefixes.some(p => job.jobName.startsWith(p))) {
      try {
        await terminateJob(job.jobId, 'Stopped by user from dashboard');
        terminated++;
      } catch {
        // job may have already finished
      }
    }
  }
  return terminated;
}

export async function POST(request) {
  try {
    const { episodeId, codec } = await request.json();

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!codec || !['h264', 'h265'].includes(codec)) {
      return NextResponse.json({ error: 'codec must be "h264" or "h265"' }, { status: 400 });
    }

    const arnKey = `lab_execution_arn_${codec}`;
    const client = await clientPromise();
    const db = client.db(DB_LAB);

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { [arnKey]: 1 } },
    );

    // A serial lab has an SFN execution ARN; a Parallel Resol lab does NOT (it
    // submits Batch jobs directly). So a missing ARN is fine — we just skip the
    // StopExecution and still terminate the orphaned Batch jobs + mark the lab
    // stopped below. (Also catches the serial race where the ARN isn't written yet.)
    const execArn = episode?.[arnKey];

    if (execArn) {
      await stopWorkflow(execArn, 'Stopped by user from dashboard');
    }

    const terminated = await terminateOrphanedBatchJobs(episodeId);

    const statusKey = `lab_status_${codec}`;
    const errorKey = `lab_error_${codec}`;
    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      {
        $set: {
          [statusKey]: 'FAILED',
          [errorKey]: 'Stopped by user',
        },
      },
    );

    return NextResponse.json({ stopped: true, batchJobsTerminated: terminated });
  } catch (err) {
    console.error('[POST /api/stop-lab]', err);
    return NextResponse.json({ error: 'Failed to stop lab execution' }, { status: 500 });
  }
}
