import { purgeAll, type Queryable, type RetentionResult } from '@arbitron/db';
import type { Job, Queue } from 'bullmq';

/**
 * The scheduled retention run (ARB-015, docs/02 T-06): "Retention period from T-06
 * enforced by scheduled job". The job itself is `purgeAll` in @arbitron/db (D-017): per
 * org it reads `settings.retention_days`, stands down and says so when there is none,
 * and otherwise redacts closed conversations quiet for longer than the period. This file
 * is the schedule and the processor that runs it.
 *
 * One scheduler, keyed by a fixed id, so every worker process that starts calls
 * `scheduleRetention` and there is still exactly one daily run (BullMQ's
 * `upsertJobScheduler` replaces a scheduler with the same id rather than adding another:
 * https://docs.bullmq.io/guide/job-schedulers).
 */
export const RETENTION_SCHEDULER_ID = 'retention-daily';

/**
 * Daily at 00:00 UTC, which is 02:00 SAST all year (D-024: no daylight saving). A quiet
 * hour, and a fixed UTC pattern needs no time-zone database on the host.
 */
export const RETENTION_PATTERN = '0 0 * * *';

export type RetentionJobData = Record<string, never>;

export interface RetentionRun {
  readonly ranAt: string;
  readonly orgs: number;
  readonly purged: number;
  readonly skippedNoPeriod: number;
  readonly threads: number;
  readonly messages: number;
  readonly discoverySessions: number;
  readonly results: readonly RetentionResult[];
}

/** Creates the daily schedule, or leaves the one that exists as it is. */
export async function scheduleRetention(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { pattern: RETENTION_PATTERN },
    { name: 'purge', data: {} satisfies RetentionJobData },
  );
}

export interface RetentionDeps {
  /** A service-role connection: the run crosses every org, outside RLS (D-017). */
  readonly db: Queryable;
  /** Defaults to the current time; tests fix it. */
  readonly now?: () => Date;
}

/** The processor for the `retention` queue. Each org's outcome is also an event (D-017). */
export function retentionProcessor(deps: RetentionDeps) {
  return async (_job: Job<RetentionJobData>): Promise<RetentionRun> => {
    const now = deps.now ? deps.now() : new Date();
    const results = await purgeAll(deps.db, now);
    const sum = (key: 'threads' | 'messages' | 'discoverySessions') =>
      results.reduce((total, result) => total + result[key], 0);
    return {
      ranAt: now.toISOString(),
      orgs: results.length,
      purged: results.filter((result) => result.status === 'purged').length,
      skippedNoPeriod: results.filter((result) => result.status === 'skipped_no_period').length,
      threads: sum('threads'),
      messages: sum('messages'),
      discoverySessions: sum('discoverySessions'),
      results,
    };
  };
}
