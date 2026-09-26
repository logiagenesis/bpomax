import { refreshPriceBands, type PriceRefreshResult, type Queryable } from '@arbitron/db';
import type { Job, Queue } from 'bullmq';

/**
 * The weekly price refresh (ARB-514, docs/01 section E: "price-refresh | weekly |
 * Updates market bands from completed-project data where the API allows; otherwise from
 * owner CSV import"). The work is `refreshPriceBands` in @arbitron/db: bands worked from
 * the house organisation's accepted deliveries (D-083). This file is the schedule and
 * the processor that runs it.
 *
 * One scheduler, keyed by a fixed id, so every worker process that starts calls
 * `schedulePriceRefresh` and there is still exactly one weekly run (BullMQ's
 * `upsertJobScheduler`: https://docs.bullmq.io/guide/job-schedulers).
 */
export const PRICE_REFRESH_SCHEDULER_ID = 'price-refresh-weekly';

/**
 * Mondays at 01:00 UTC, which is 03:00 SAST all year (D-024): after the daily retention
 * run, before the working week.
 */
export const PRICE_REFRESH_PATTERN = '0 1 * * 1';

type PriceRefreshJobData = Record<string, never>;

export interface PriceRefreshRun extends PriceRefreshResult {
  readonly ranAt: string;
}

export async function schedulePriceRefresh(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    PRICE_REFRESH_SCHEDULER_ID,
    { pattern: PRICE_REFRESH_PATTERN },
    { name: 'refresh', data: {} satisfies PriceRefreshJobData },
  );
}

interface PriceRefreshDeps {
  /** A service-role connection: the bands are shared, outside any one org (D-017). */
  readonly db: Queryable;
  readonly now?: () => Date;
}

export function priceRefreshProcessor(deps: PriceRefreshDeps) {
  return async (job: Job<PriceRefreshJobData>): Promise<PriceRefreshRun> => {
    const now = deps.now ? deps.now() : new Date();
    const result = await refreshPriceBands(deps.db, { now, requestId: job.id ?? null });
    return { ranAt: now.toISOString(), ...result };
  };
}
