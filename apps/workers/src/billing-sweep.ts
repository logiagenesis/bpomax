import { downgradeExpired, type Queryable } from '@arbitron/db';
import type { Job, Queue } from 'bullmq';

/**
 * The daily billing sweep (ARB-420: "failed payment downgrades after grace period"). A
 * plan whose grace period has run out stops working at that moment (`loadOrgPlan`); this
 * run cancels the subscription and records `billing.downgraded`, so the record says what
 * already holds. One scheduler with a fixed id, as the retention run (D-039).
 */
export const BILLING_SCHEDULER_ID = 'billing-daily';

/** 00:30 UTC, 02:30 SAST: after the retention run, in the same quiet hour. */
export const BILLING_PATTERN = '30 0 * * *';

export type BillingSweepJobData = Record<string, never>;

export async function scheduleBillingSweep(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    BILLING_SCHEDULER_ID,
    { pattern: BILLING_PATTERN },
    { name: 'sweep', data: {} satisfies BillingSweepJobData },
  );
}

export interface BillingSweepDeps {
  /** A service-role connection: the sweep crosses every org. */
  readonly db: Queryable;
  readonly now?: () => Date;
}

export function billingSweepProcessor(deps: BillingSweepDeps) {
  return async (_job: Job<BillingSweepJobData>) => {
    const now = deps.now ? deps.now() : new Date();
    const downgraded = await downgradeExpired(deps.db, now);
    return { ranAt: now.toISOString(), downgraded };
  };
}
