import { NextResponse } from 'next/server';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { BatchClient, ListJobsCommand, TerminateJobCommand } from '@aws-sdk/client-batch';
import clientPromise from '@/lib/mongodb';

const region = process.env.AWS_REGION || 'us-east-1';
const sfn = new SFNClient({ region });
const batch = new BatchClient({ region });

const BATCH_STATUSES = ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'];

async function terminateOrphanedBatchJobs(episodeId) {
  const prefix = `ChaiQSearch-${episodeId.slice(0, 24)}-`;
  const queue = process.env.BATCH_JOB_QUEUE;
  if (!queue) return 0;

  let terminated = 0;
  for (const status of BATCH_STATUSES) {
    try {
      const resp = await batch.send(
        new ListJobsCommand({ jobQueue: queue, jobStatus: status }),
      );
      for (const job of resp.jobSummaryList || []) {
        if (job.jobName?.startsWith(prefix)) {
          try {
            await batch.send(
              new TerminateJobCommand({
                jobId: job.jobId,
                reason: 'Stopped by user from dashboard',
              }),
            );
            terminated++;
          } catch {
            // job may have already finished
          }
        }
      }
    } catch {
      // list may fail for a status, continue with others
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
    const db = client.db('chai_q_lab');

    const episode = await db.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { [arnKey]: 1 } },
    );

    const execArn = episode?.[arnKey];
    if (!execArn) {
      return NextResponse.json({ error: 'No execution ARN found for this codec' }, { status: 400 });
    }

    await sfn.send(
      new StopExecutionCommand({
        executionArn: execArn,
        cause: 'Stopped by user from dashboard',
      }),
    );

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
