import { UnrecoverableError, Worker, type ConnectionOptions, type Job, type Queue } from 'bullmq';
import type { QueueName } from './queues.js';

/** What lands in the dead-letter queue: enough to understand the failure and replay it. */
export interface DeadLetter {
  readonly queue: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly deadAt: string;
}

export type Processor<Data = unknown, Result = unknown> = (
  job: Job<Data, Result>,
) => Promise<Result>;

export interface StartWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly deadLetter: Queue;
  readonly prefix?: string;
  readonly concurrency?: number;
}

/**
 * The job's last attempt, after which BullMQ will not retry. `attemptsMade` counts the
 * attempts already finished, so during the current one it is one short.
 */
function isFinalAttempt(job: Job, error: unknown): boolean {
  if (error instanceof UnrecoverableError) return true;
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * Starts a worker whose final failures are copied to the dead-letter queue.
 *
 * The copy is made inside the processor, before the error is rethrown, rather than from
 * the worker's `failed` event. An event handler runs after BullMQ has already recorded
 * the failure, so a crash or a Redis blip in between would lose the dead letter with
 * nothing to show it was ever owed. Done here, the job is not marked failed until its
 * dead letter exists; if writing it fails, that error fails the job instead and is
 * visible in the failed set. The dead letter's id is derived from the job's, so a
 * redelivered attempt cannot file it twice.
 */
export function startWorker<Data, Result>(
  name: QueueName,
  processor: Processor<Data, Result>,
  options: StartWorkerOptions,
): Worker<Data, Result> {
  return new Worker<Data, Result>(
    name,
    async (job) => {
      try {
        return await processor(job);
      } catch (error) {
        if (isFinalAttempt(job, error)) {
          const letter: DeadLetter = {
            queue: name,
            jobId: String(job.id),
            jobName: job.name,
            data: job.data,
            attemptsMade: job.attemptsMade + 1,
            failedReason: error instanceof Error ? error.message : String(error),
            deadAt: new Date().toISOString(),
          };
          await options.deadLetter.add(`${name}:${job.name}`, letter, {
            jobId: `${name}__${job.id}`,
          });
        }
        throw error;
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
}
