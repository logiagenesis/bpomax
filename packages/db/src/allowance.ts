import {
  bidMetric,
  bidPeriod,
  checkBidAllowance,
  type AllowanceVerdict,
  type Platform,
} from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * Bid allowance tracking (ARB-042). `usage_counters` holds bids used per org, platform
 * and month; `platform_accounts` holds the allowance the owner recorded (docs/02 T-03).
 *
 * A bid is counted the moment it is reserved, before the platform is called, by one
 * conditional upsert: the row's `used` moves only while it is below the allowance, so two
 * submissions racing for the last bid cannot both have it. A submission that then fails
 * before the platform accepted it gives the bid back with `releaseBid`.
 */
export interface BidAccountInput {
  readonly orgId: string;
  readonly platform: Platform;
  /** Defaults to the current time. Tests pass a fixed one. */
  readonly now?: Date;
}

interface AccountRow {
  plan_name: string | null;
  monthly_bid_allowance: number | null;
}

async function loadAccount(db: Queryable, input: BidAccountInput): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    'select plan_name, monthly_bid_allowance from platform_accounts where org_id = $1 and platform = $2',
    [input.orgId, input.platform],
  );
  return rows[0] ?? null;
}

async function usedThisPeriod(db: Queryable, input: BidAccountInput, periodStart: string) {
  const { rows } = await db.query<{ used: number }>(
    'select used from usage_counters where org_id = $1 and metric = $2 and period_start = $3',
    [input.orgId, bidMetric(input.platform), periodStart],
  );
  return rows[0]?.used ?? 0;
}

/** How the allowance stands, without taking a bid. */
export async function bidUsage(db: Queryable, input: BidAccountInput): Promise<AllowanceVerdict> {
  const period = bidPeriod(input.now ?? new Date());
  const account = await loadAccount(db, input);
  const used = await usedThisPeriod(db, input, period.start);
  return checkBidAllowance({
    platform: input.platform,
    account: account && { planName: account.plan_name, allowance: account.monthly_bid_allowance },
    used,
    period,
  });
}

/**
 * Takes one bid from the allowance, or says why it cannot. On success `used` includes
 * the bid just taken.
 */
export async function reserveBid(db: Queryable, input: BidAccountInput): Promise<AllowanceVerdict> {
  const period = bidPeriod(input.now ?? new Date());
  const account = await loadAccount(db, input);
  const allowance = account?.monthly_bid_allowance ?? null;

  // Nothing to take from: judged on what is known, and the counter is not touched.
  if (!account || allowance === null || allowance === 0) {
    return bidUsage(db, input);
  }

  const { rows } = await db.query<{ used: number }>(
    `insert into usage_counters (org_id, metric, period_start, used, limit_value)
     values ($1, $2, $3, 1, $4)
     on conflict (org_id, metric, period_start) do update
       set used = usage_counters.used + 1, limit_value = excluded.limit_value
       where usage_counters.used < excluded.limit_value
     returning used`,
    [input.orgId, bidMetric(input.platform), period.start, allowance],
  );
  const taken = rows[0];
  if (!taken) return bidUsage(db, input);
  return {
    ok: true,
    used: taken.used,
    limit: allowance,
    remaining: allowance - taken.used,
    period,
  };
}

/** Gives back a bid that was reserved but never placed. Never goes below zero. */
export async function releaseBid(db: Queryable, input: BidAccountInput): Promise<number> {
  const period = bidPeriod(input.now ?? new Date());
  const { rows } = await db.query<{ used: number }>(
    `update usage_counters set used = greatest(used - 1, 0)
     where org_id = $1 and metric = $2 and period_start = $3
     returning used`,
    [input.orgId, bidMetric(input.platform), period.start],
  );
  return rows[0]?.used ?? 0;
}
