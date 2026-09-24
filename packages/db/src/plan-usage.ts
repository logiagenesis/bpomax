import {
  checkUsage,
  planMetricKey,
  thresholdsCrossed,
  usagePeriod,
  validatePlan,
  type OrgPlan,
  type PlanMetric,
  type UsageThreshold,
  type UsageVerdict,
} from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * Plans and usage (ARB-410): which plan an org is on, how much of each metered action it
 * has used this month, and taking one more.
 *
 * The count moves by one conditional upsert, as ARB-042's bid allowance does (D-030):
 * the row's `used` rises only while it stays within the limit, so two actions racing for
 * the last one cannot both have it. Reads work under RLS for a member (the API's checks)
 * and as service_role (the workers, which take the action).
 */
export interface OrgPlanRow {
  readonly orgName: string;
  readonly orgPlan: OrgPlan;
}

export async function loadOrgPlan(db: Queryable, orgId: string): Promise<OrgPlanRow | null> {
  const { rows } = await db.query<{
    org_name: string;
    billing_exempt: boolean;
    subscription_plan: string | null;
    status: string | null;
    plan_code: string | null;
    plan_name: string | null;
    plan_active: boolean | null;
    limits: unknown;
    plan_count: number;
  }>(
    `select o.name as org_name, o.billing_exempt, s.plan as subscription_plan, s.status,
            p.code as plan_code, p.name as plan_name, p.active as plan_active, p.limits,
            (select count(*)::int from plans) as plan_count
       from orgs o
       left join subscriptions s on s.org_id = o.id
       left join plans p on p.code = s.plan
      where o.id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) return null;
  const orgPlan = ((): OrgPlan => {
    if (row.billing_exempt) return { kind: 'exempt' };
    if (row.plan_count === 0) return { kind: 'none', reason: 'no_plans' };
    if (!row.subscription_plan || !row.status) return { kind: 'none', reason: 'no_subscription' };
    if (row.status === 'cancelled') return { kind: 'none', reason: 'cancelled' };
    if (!row.plan_code) return { kind: 'none', reason: 'unknown_plan' };
    // A retired plan (`active` false) still holds for the orgs already on it; it is only
    // withdrawn from sale (ARB-420).
    const parsed = validatePlan({
      code: row.plan_code,
      name: row.plan_name,
      active: row.plan_active,
      limits: row.limits,
    });
    if (!parsed.ok) return { kind: 'none', reason: 'unknown_plan' };
    return {
      kind: 'plan',
      plan: parsed.value,
      status: row.status as 'trialing' | 'active' | 'past_due',
    };
  })();
  return { orgName: row.org_name, orgPlan };
}

export async function usedThisMonth(
  db: Queryable,
  orgId: string,
  metric: PlanMetric,
  now: Date,
): Promise<number> {
  const { rows } = await db.query<{ used: number }>(
    'select used from usage_counters where org_id = $1 and metric = $2 and period_start = $3',
    [orgId, planMetricKey(metric), usagePeriod(now).start],
  );
  return rows[0]?.used ?? 0;
}

export interface PlanUsageInput {
  readonly orgId: string;
  readonly metric: PlanMetric;
  /** Defaults to the current time. Tests pass a fixed one. */
  readonly now?: Date;
  readonly amount?: number;
}

/** How the org stands for one more of `metric`, without taking it. */
export async function planUsage(db: Queryable, input: PlanUsageInput): Promise<UsageVerdict> {
  const now = input.now ?? new Date();
  const loaded = await loadOrgPlan(db, input.orgId);
  const orgPlan: OrgPlan = loaded?.orgPlan ?? { kind: 'none', reason: 'no_subscription' };
  const used = await usedThisMonth(db, input.orgId, input.metric, now);
  return checkUsage({
    orgPlan,
    metric: input.metric,
    used,
    period: usagePeriod(now),
    ...(input.amount === undefined ? {} : { amount: input.amount }),
  });
}

export interface Reservation {
  readonly verdict: UsageVerdict;
  /** The alert thresholds this action crossed; each fires once a month. */
  readonly crossed: readonly UsageThreshold[];
  readonly orgName: string;
  /** Null for the house org. */
  readonly planName: string | null;
}

/**
 * Takes `amount` of `metric` for the month, or says why it cannot. The house org and a
 * plan with no limit on the metric are counted without a ceiling, so the usage page
 * shows what they used.
 */
export async function reservePlanUsage(db: Queryable, input: PlanUsageInput): Promise<Reservation> {
  const now = input.now ?? new Date();
  const amount = input.amount ?? 1;
  const period = usagePeriod(now);
  const loaded = await loadOrgPlan(db, input.orgId);
  const orgPlan: OrgPlan = loaded?.orgPlan ?? { kind: 'none', reason: 'no_subscription' };
  const orgName = loaded?.orgName ?? '';
  const planName = orgPlan.kind === 'plan' ? orgPlan.plan.name : null;
  const refused = async (): Promise<Reservation> => ({
    verdict: checkUsage({
      orgPlan,
      metric: input.metric,
      used: await usedThisMonth(db, input.orgId, input.metric, now),
      period,
      amount,
    }),
    crossed: [],
    orgName,
    planName,
  });

  if (orgPlan.kind === 'none') return refused();
  const limit = orgPlan.kind === 'plan' ? orgPlan.plan.limits[input.metric] : null;
  if (limit !== null && amount > limit) return refused();

  const { rows } = await db.query<{ used: number }>(
    `insert into usage_counters (org_id, metric, period_start, used, limit_value)
     values ($1, $2, $3, $4, $5)
     on conflict (org_id, metric, period_start) do update
       set used = usage_counters.used + $4, limit_value = excluded.limit_value
       where excluded.limit_value is null or usage_counters.used + $4 <= excluded.limit_value
     returning used`,
    [input.orgId, planMetricKey(input.metric), period.start, amount, limit],
  );
  const taken = rows[0];
  if (!taken) return refused();
  return {
    verdict: { ok: true, used: taken.used, limit, period },
    crossed: thresholdsCrossed(taken.used - amount, taken.used, limit),
    orgName,
    planName,
  };
}

/** Gives back an action that was taken but did not happen. Never goes below zero. */
export async function releasePlanUsage(db: Queryable, input: PlanUsageInput): Promise<number> {
  const now = input.now ?? new Date();
  const { rows } = await db.query<{ used: number }>(
    `update usage_counters set used = greatest(used - $4, 0)
      where org_id = $1 and metric = $2 and period_start = $3
      returning used`,
    [input.orgId, planMetricKey(input.metric), usagePeriod(now).start, input.amount ?? 1],
  );
  return rows[0]?.used ?? 0;
}
