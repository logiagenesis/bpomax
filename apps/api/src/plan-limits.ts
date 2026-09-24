import type { PlanMetric } from '@arbitron/core';
import { planUsage, type Queryable } from '@arbitron/db';
import { refuse } from './errors.js';

/**
 * The plan check a request makes before it hands work to a worker (ARB-410), so a
 * person pressing the button is told at once, in the plan's own words, rather than
 * finding a blocked event later. The worker still takes the action with the database's
 * conditional count; this only reads. 402: the plan, not the request, is what stops it.
 */
export async function refuseOverLimit(
  tx: Queryable,
  orgId: string,
  metric: PlanMetric,
  now?: Date,
): Promise<void> {
  const verdict = await planUsage(tx, { orgId, metric, ...(now ? { now } : {}) });
  if (!verdict.ok) throw refuse(402, verdict.message);
}
