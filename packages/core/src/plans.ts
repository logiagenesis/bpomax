import { bidPeriod, type BidPeriod } from './allowance.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Plans, limits and usage (ARB-410, docs/01 section D: `subscriptions`, `usage_counters`).
 *
 * What a plan allows is the owner's decision (docs/02 D-12: "Earlier working figures are
 * not approved"), so no plan, limit or price is written here. This module holds the
 * rules: which actions are metered, the shape a plan is published in
 * (`packages/db/seed/plans.json`), whether one more action fits, what to say when it does
 * not, and when the 80 % and 100 % alerts fire.
 */

/**
 * The metered actions: the ones that cost money per use (a model call to score or to
 * draft) or carry the product's value (a bid placed). Counted per org per calendar month
 * in South African time, like the bid allowance (D-030).
 */
export const PLAN_METRICS = ['jobs_scored', 'bids_drafted', 'bids_submitted'] as const;
export type PlanMetric = (typeof PLAN_METRICS)[number];

export const PLAN_METRIC_LABELS: Record<PlanMetric, string> = {
  jobs_scored: 'Jobs scored',
  bids_drafted: 'Bids drafted',
  bids_submitted: 'Bids sent',
};

/** What each action is called in a sentence: "The plan's limit for <this> is reached". */
const METRIC_ACTIONS: Record<PlanMetric, string> = {
  jobs_scored: 'scoring jobs',
  bids_drafted: 'drafting bids',
  bids_submitted: 'sending bids',
};

export function isPlanMetric(value: unknown): value is PlanMetric {
  return typeof value === 'string' && (PLAN_METRICS as readonly string[]).includes(value);
}

/** The `usage_counters.metric` for a plan metric; `bids:<platform>` is ARB-042's. */
export function planMetricKey(metric: PlanMetric): string {
  return `plan:${metric}`;
}

/** The usage period: the calendar month, in South African time, that `now` falls in. */
export function usagePeriod(now: Date): BidPeriod {
  return bidPeriod(now);
}

/** A monthly limit per metric: a whole number, or null for no limit on that plan. */
export type PlanLimits = Readonly<Record<PlanMetric, number | null>>;

/**
 * What a plan costs, per currency, and the provider's own reference for it (ARB-420):
 * rand through Paystack, its plan code; US dollars through Stripe, its recurring Price.
 * The figures and references are the owner's (docs/02 D-12, B-15); a currency left out is
 * simply not on sale.
 */
export interface PlanPrices {
  readonly ZAR?: { readonly amountMinor: number; readonly paystackPlanCode: string };
  readonly USD?: { readonly amountMinor: number; readonly stripePriceId: string };
}

export interface Plan {
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly limits: PlanLimits;
  readonly prices: PlanPrices;
}

/**
 * A plan as the owner publishes it. Every metric must be stated, as a whole number or
 * as null for "no limit": a metric left out is refused rather than read as unlimited,
 * because a limit nobody wrote down cannot be assumed generous.
 */
export function validatePlan(input: unknown): ValidationResult<Plan> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'plan', message: 'must be an object' }] };
  }
  const plan = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const code = typeof plan.code === 'string' ? plan.code.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(code)) {
    errors.push({
      field: 'code',
      message: 'must be 1 to 40 lower-case letters, digits or hyphens',
    });
  }
  const name = typeof plan.name === 'string' ? plan.name.trim() : '';
  if (!name) errors.push({ field: 'name', message: 'is required' });
  const active = plan.active ?? true;
  if (typeof active !== 'boolean')
    errors.push({ field: 'active', message: 'must be true or false' });

  const rawLimits = plan.limits;
  const limits: Partial<Record<PlanMetric, number | null>> = {};
  if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
    errors.push({ field: 'limits', message: 'must state a limit for every metric' });
  } else {
    const given = rawLimits as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!isPlanMetric(key)) errors.push({ field: `limits.${key}`, message: 'is not a metric' });
    }
    for (const metric of PLAN_METRICS) {
      if (!(metric in given)) {
        errors.push({
          field: `limits.${metric}`,
          message: 'must be stated: a whole number, or null for no limit',
        });
        continue;
      }
      const value = given[metric];
      if (value === null) limits[metric] = null;
      else if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
        limits[metric] = value;
      else
        errors.push({
          field: `limits.${metric}`,
          message: 'must be a whole number of 0 or more, or null for no limit',
        });
    }
  }
  const prices: { ZAR?: PlanPrices['ZAR']; USD?: PlanPrices['USD'] } = {};
  const rawPrices = plan.prices ?? {};
  if (typeof rawPrices !== 'object' || rawPrices === null || Array.isArray(rawPrices)) {
    errors.push({ field: 'prices', message: 'must be an object keyed by currency' });
  } else {
    const given = rawPrices as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (key !== 'ZAR' && key !== 'USD') {
        errors.push({
          field: `prices.${key}`,
          message: 'is not sold: rand goes through Paystack and US dollars through Stripe',
        });
      }
    }
    const amountOf = (currency: 'ZAR' | 'USD', value: Record<string, unknown>) => {
      const amount = value.amountMinor;
      if (typeof amount === 'number' && Number.isInteger(amount) && amount > 0) return amount;
      errors.push({
        field: `prices.${currency}.amountMinor`,
        message: 'must be a whole number of cents above 0',
      });
      return 0;
    };
    const zar = given.ZAR as Record<string, unknown> | undefined;
    if (zar !== undefined) {
      const amountMinor = amountOf('ZAR', zar ?? {});
      const code = typeof zar?.paystackPlanCode === 'string' ? zar.paystackPlanCode.trim() : '';
      if (!code) {
        errors.push({
          field: 'prices.ZAR.paystackPlanCode',
          message: 'must be the plan code from the Paystack dashboard',
        });
      }
      prices.ZAR = { amountMinor, paystackPlanCode: code };
    }
    const usd = given.USD as Record<string, unknown> | undefined;
    if (usd !== undefined) {
      const amountMinor = amountOf('USD', usd ?? {});
      const id = typeof usd?.stripePriceId === 'string' ? usd.stripePriceId.trim() : '';
      if (!id) {
        errors.push({
          field: 'prices.USD.stripePriceId',
          message: 'must be the recurring Price id from the Stripe dashboard',
        });
      }
      prices.USD = { amountMinor, stripePriceId: id };
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { code, name, active: active as boolean, limits: limits as PlanLimits, prices },
  };
}

/** Where an org stands for billing, as read from `orgs`, `subscriptions` and `plans`. */
export type OrgPlan =
  /** The house org (D-069): counted, never limited, never billed. */
  | { readonly kind: 'exempt' }
  | {
      readonly kind: 'plan';
      readonly plan: Plan;
      readonly status: 'trialing' | 'active' | 'past_due';
    }
  | {
      readonly kind: 'none';
      readonly reason:
        | 'no_subscription'
        | 'cancelled'
        | 'unknown_plan'
        | 'no_plans'
        /** ARB-420: a payment failed and the grace period ran out. */
        | 'grace_ended';
    };

function dayForPeople(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

export type UsageVerdict =
  | {
      readonly ok: true;
      /** After this action, when it is taken. */
      readonly used: number;
      /** Null when the plan sets no limit, or the org is exempt. */
      readonly limit: number | null;
      readonly period: BidPeriod;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_plan' | 'not_included' | 'limit_reached';
      /** Plain language: what is blocking and what would clear it. */
      readonly message: string;
      readonly used: number;
      readonly limit: number | null;
      readonly period: BidPeriod;
    };

/** Why an org with no plan cannot take a metered action. */
export function noPlanMessage(reason: Extract<OrgPlan, { kind: 'none' }>['reason']): string {
  switch (reason) {
    case 'no_plans':
      return 'No plans are published yet, so metered actions are off for this organisation (docs/02 D-12).';
    case 'unknown_plan':
      return "This organisation's plan is no longer offered. Choose a plan in Settings to continue.";
    case 'cancelled':
      return "This organisation's plan has ended. Choose a plan in Settings to continue.";
    case 'grace_ended':
      return "A payment for this organisation's plan failed and the grace period has ended. Pay what is owed with the payment provider, or choose a plan in Settings, to continue.";
    default:
      return 'This organisation has no plan yet. Choose a plan in Settings to continue.';
  }
}

/**
 * Whether `amount` more of `metric` fits in the month, given how much is used. Judged on
 * the counter as it stands; the database takes the action with one conditional update,
 * so two at once cannot both have the last one.
 */
export function checkUsage(input: {
  readonly orgPlan: OrgPlan;
  readonly metric: PlanMetric;
  readonly used: number;
  readonly period: BidPeriod;
  readonly amount?: number;
}): UsageVerdict {
  const { orgPlan, metric, used, period } = input;
  const amount = input.amount ?? 1;
  if (orgPlan.kind === 'exempt') return { ok: true, used: used + amount, limit: null, period };
  if (orgPlan.kind === 'none') {
    return {
      ok: false,
      reason: 'no_plan',
      message: noPlanMessage(orgPlan.reason),
      used,
      limit: null,
      period,
    };
  }
  const limit = orgPlan.plan.limits[metric];
  if (limit === null) return { ok: true, used: used + amount, limit: null, period };
  if (limit === 0) {
    return {
      ok: false,
      reason: 'not_included',
      message: `The ${orgPlan.plan.name} plan does not include ${METRIC_ACTIONS[metric]}. Choose another plan in Settings.`,
      used,
      limit,
      period,
    };
  }
  if (used + amount > limit) {
    return {
      ok: false,
      reason: 'limit_reached',
      message: `The ${orgPlan.plan.name} plan's monthly limit for ${METRIC_ACTIONS[metric]} is reached: ${String(used)} of ${String(limit)} used. It resets on ${dayForPeople(period.resetsOn)}. Choose a bigger plan in Settings to go on now.`,
      used,
      limit,
      period,
    };
  }
  return { ok: true, used: used + amount, limit, period };
}

/** The alert thresholds, in per cent of a limit (ARB-410: "80%/100% alerts"). */
export const USAGE_THRESHOLDS = [80, 100] as const;
export type UsageThreshold = (typeof USAGE_THRESHOLDS)[number];

/**
 * The thresholds a step from `before` to `after` crosses. Each fires once a month: only
 * the action that crosses it reports it, and a counter only moves up within a month.
 * Integer arithmetic, so 80 % of 5 is crossed at exactly 4.
 */
export function thresholdsCrossed(
  before: number,
  after: number,
  limit: number | null,
): UsageThreshold[] {
  if (limit === null || limit <= 0) return [];
  return USAGE_THRESHOLDS.filter((t) => before * 100 < t * limit && after * 100 >= t * limit);
}

/** The alert's wording, the same on Telegram and by email. */
export function usageAlertText(input: {
  readonly orgName: string;
  readonly planName: string;
  readonly metric: PlanMetric;
  readonly threshold: UsageThreshold;
  readonly used: number;
  readonly limit: number;
  readonly period: BidPeriod;
}): { subject: string; body: string } {
  const label = PLAN_METRIC_LABELS[input.metric];
  const counts = `${String(input.used)} of ${String(input.limit)} used this month`;
  const resets = `It resets on ${dayForPeople(input.period.resetsOn)}.`;
  if (input.threshold === 100) {
    return {
      subject: `${input.orgName}: ${label} limit reached`,
      body: [
        `${label}: the ${input.planName} plan's monthly limit is reached (${counts}).`,
        `Nothing more of this kind happens until the limit resets or the plan changes. ${resets}`,
        'Choose a bigger plan in Settings to go on now.',
      ].join('\n'),
    };
  }
  return {
    subject: `${input.orgName}: ${label} at ${String(input.threshold)}% of the limit`,
    body: [
      `${label}: ${counts} on the ${input.planName} plan.`,
      `At the limit, this kind of action stops until the limit resets. ${resets}`,
    ].join('\n'),
  };
}
