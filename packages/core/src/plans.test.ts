import { describe, expect, it } from 'vitest';
import {
  PLAN_METRICS,
  checkUsage,
  planMetricKey,
  thresholdsCrossed,
  usageAlertText,
  usagePeriod,
  validatePlan,
  type OrgPlan,
  type Plan,
} from './plans.js';

/**
 * ARB-410. The plans here are test fixtures with made-up names and limits; no real plan
 * or price is written anywhere in the code (docs/02 D-12).
 */
const PERIOD = usagePeriod(new Date('2026-09-24T08:00:00Z'));
const TEST_PLAN: Plan = {
  code: 'test-small',
  name: 'Test small',
  active: true,
  limits: { jobs_scored: 5, bids_drafted: 0, bids_submitted: null },
  prices: {},
};
const ON_PLAN: OrgPlan = { kind: 'plan', plan: TEST_PLAN, status: 'active' };

describe('usagePeriod', () => {
  it('is the calendar month in South African time', () => {
    expect(PERIOD).toEqual({ start: '2026-09-01', resetsOn: '2026-10-01' });
    // 22:30 UTC on 30/09 is 00:30 on 01/10 in Pretoria.
    expect(usagePeriod(new Date('2026-09-30T22:30:00Z')).start).toBe('2026-10-01');
  });

  it('keys plan counters apart from the bid allowance', () => {
    expect(planMetricKey('bids_submitted')).toBe('plan:bids_submitted');
  });
});

describe('validatePlan', () => {
  it('accepts a plan that states every metric, null meaning no limit', () => {
    expect(validatePlan({ ...TEST_PLAN })).toEqual({ ok: true, value: TEST_PLAN });
  });

  it('refuses a metric left out, rather than reading it as unlimited', () => {
    const result = validatePlan({ ...TEST_PLAN, limits: { jobs_scored: 5, bids_drafted: 1 } });
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          field: 'limits.bids_submitted',
          message: 'must be stated: a whole number, or null for no limit',
        },
      ],
    });
  });

  it.each([
    [{ ...TEST_PLAN, code: 'Has Spaces' }, 'code'],
    [{ ...TEST_PLAN, name: ' ' }, 'name'],
    [{ ...TEST_PLAN, active: 'yes' }, 'active'],
    [{ ...TEST_PLAN, limits: null }, 'limits'],
    [{ ...TEST_PLAN, limits: { ...TEST_PLAN.limits, jobs_scored: -1 } }, 'limits.jobs_scored'],
    [{ ...TEST_PLAN, limits: { ...TEST_PLAN.limits, jobs_scored: 1.5 } }, 'limits.jobs_scored'],
    [{ ...TEST_PLAN, limits: { ...TEST_PLAN.limits, seats: 3 } }, 'limits.seats'],
  ])('refuses %j on %s', (input, field) => {
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });
});

describe('validatePlan: prices (ARB-420)', () => {
  // Made-up figures and references for the test; real ones are D-12's and B-15's.
  const PRICED = {
    ...TEST_PLAN,
    prices: {
      ZAR: { amountMinor: 10_000, paystackPlanCode: 'PLN_test' },
      USD: { amountMinor: 1_000, stripePriceId: 'price_test' },
    },
  };

  it('accepts a price per currency with the provider s own reference', () => {
    expect(validatePlan(PRICED)).toEqual({ ok: true, value: PRICED });
  });

  it('treats a plan with no prices as not on sale, not as free', () => {
    const result = validatePlan({ ...TEST_PLAN, prices: undefined });
    expect(result).toMatchObject({ ok: true, value: { prices: {} } });
  });

  it.each([
    [{ EUR: { amountMinor: 1 } }, 'prices.EUR'],
    [{ ZAR: { amountMinor: 0, paystackPlanCode: 'PLN_x' } }, 'prices.ZAR.amountMinor'],
    [{ ZAR: { amountMinor: 99.5, paystackPlanCode: 'PLN_x' } }, 'prices.ZAR.amountMinor'],
    [{ ZAR: { amountMinor: 100 } }, 'prices.ZAR.paystackPlanCode'],
    [{ USD: { amountMinor: 100, stripePriceId: ' ' } }, 'prices.USD.stripePriceId'],
    [[], 'prices'],
  ])('refuses prices %j on %s', (prices, field) => {
    const result = validatePlan({ ...TEST_PLAN, prices });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });
});

describe('checkUsage', () => {
  const check = (orgPlan: OrgPlan, metric: (typeof PLAN_METRICS)[number], used: number) =>
    checkUsage({ orgPlan, metric, used, period: PERIOD });

  it('lets an action through while it fits, and at exactly the limit', () => {
    expect(check(ON_PLAN, 'jobs_scored', 0)).toMatchObject({ ok: true, used: 1, limit: 5 });
    expect(check(ON_PLAN, 'jobs_scored', 4)).toMatchObject({ ok: true, used: 5, limit: 5 });
  });

  it('refuses the action past the limit, saying the count, the reset day and what to do', () => {
    expect(check(ON_PLAN, 'jobs_scored', 5)).toEqual({
      ok: false,
      reason: 'limit_reached',
      message:
        "The Test small plan's monthly limit for scoring jobs is reached: 5 of 5 used. It resets on 01/10/2026. Choose a bigger plan in Settings to go on now.",
      used: 5,
      limit: 5,
      period: PERIOD,
    });
  });

  it('refuses a metric the plan does not include', () => {
    expect(check(ON_PLAN, 'bids_drafted', 0)).toMatchObject({
      ok: false,
      reason: 'not_included',
      message:
        'The Test small plan does not include drafting bids. Choose another plan in Settings.',
    });
  });

  it('counts but never limits a metric the plan leaves open, or an exempt org', () => {
    expect(check(ON_PLAN, 'bids_submitted', 10_000)).toMatchObject({ ok: true, limit: null });
    expect(check({ kind: 'exempt' }, 'jobs_scored', 10_000)).toMatchObject({
      ok: true,
      used: 10_001,
      limit: null,
    });
  });

  it.each([
    [
      'no_subscription',
      'This organisation has no plan yet. Choose a plan in Settings to continue.',
    ],
    ['cancelled', "This organisation's plan has ended. Choose a plan in Settings to continue."],
    [
      'unknown_plan',
      "This organisation's plan is no longer offered. Choose a plan in Settings to continue.",
    ],
    [
      'no_plans',
      'No plans are published yet, so metered actions are off for this organisation (docs/02 D-12).',
    ],
  ] as const)('refuses every metered action with no plan (%s)', (reason, message) => {
    for (const metric of PLAN_METRICS) {
      expect(check({ kind: 'none', reason }, metric, 0)).toMatchObject({
        ok: false,
        reason: 'no_plan',
        message,
      });
    }
  });
});

describe('thresholdsCrossed', () => {
  it('fires 80 % on the action that reaches it, and 100 % on the one that reaches the limit', () => {
    expect(thresholdsCrossed(3, 4, 5)).toEqual([80]);
    expect(thresholdsCrossed(4, 5, 5)).toEqual([100]);
    expect(thresholdsCrossed(0, 5, 5)).toEqual([80, 100]);
  });

  it('fires nothing below 80 %, after a threshold, or without a limit', () => {
    expect(thresholdsCrossed(2, 3, 5)).toEqual([]);
    expect(thresholdsCrossed(4, 4, 5)).toEqual([]);
    expect(thresholdsCrossed(79, 80, null)).toEqual([]);
    expect(thresholdsCrossed(0, 0, 0)).toEqual([]);
  });

  it('works in whole numbers at the edges: 80 of 100, and 8 of 10', () => {
    expect(thresholdsCrossed(79, 80, 100)).toEqual([80]);
    expect(thresholdsCrossed(7, 8, 10)).toEqual([80]);
    expect(thresholdsCrossed(80, 81, 100)).toEqual([]);
  });
});

describe('usageAlertText', () => {
  it('says the count, the plan and the reset day at 80 %', () => {
    expect(
      usageAlertText({
        orgName: 'New Studio',
        planName: 'Test small',
        metric: 'jobs_scored',
        threshold: 80,
        used: 4,
        limit: 5,
        period: PERIOD,
      }),
    ).toEqual({
      subject: 'New Studio: Jobs scored at 80% of the limit',
      body: 'Jobs scored: 4 of 5 used this month on the Test small plan.\nAt the limit, this kind of action stops until the limit resets. It resets on 01/10/2026.',
    });
  });

  it('says what stops, and what would clear it, at 100 %', () => {
    const text = usageAlertText({
      orgName: 'New Studio',
      planName: 'Test small',
      metric: 'bids_submitted',
      threshold: 100,
      used: 5,
      limit: 5,
      period: PERIOD,
    });
    expect(text.subject).toBe('New Studio: Bids sent limit reached');
    expect(text.body).toContain('Nothing more of this kind happens until the limit resets');
    expect(text.body).toContain('It resets on 01/10/2026.');
  });
});
