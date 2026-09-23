import { insertBriefVersion, listEvents, lockBrief } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateJobMargin } from './margin.js';
import { repriceCandidate, type RepriceAlert, type RepriceDeps } from './reprice.js';

/**
 * ARB-204 acceptance: "Margin recalculated and change logged; alert fires on breach".
 * Real Postgres (PGlite) for the rows; the margin engine is the ARB-041 one, unchanged.
 *
 * The rules and the fee table are this file's test data (docs/02 D-02, D-03 and T-02 are
 * open). Every figure below is worked by hand: a ZAR job with a R5 000,00 budget, a 10%
 * fee with no minimum (R500,00), no FX buffer on a ZAR deal, and a rule of 20% and R500,00.
 */
const ORG = fixtureId('a', ENTITY.org);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let jobId: string;
let requestId: string;
const alerts: RepriceAlert[] = [];
const deps = (): RepriceDeps => ({
  db,
  alert: (alert) => {
    alerts.push(alert);
    return Promise.resolve(1);
  },
});

const FEE_TABLE = [
  {
    platform: 'freelancer',
    project_type: 'fixed',
    side: 'freelancer',
    percent: 10,
    source_url: 'https://example.test/fees',
    read_on: '2026-09-22',
  },
];

async function setRules(on: boolean): Promise<void> {
  await db.query(
    `update settings set min_margin_pct = $2, min_margin_zar_minor = $3, fx_buffer_pct = $4,
                         fee_table = $5::jsonb where org_id = $1`,
    on ? [ORG, 20, 50_000, 3, JSON.stringify(FEE_TABLE)] : [ORG, null, null, null, '[]'],
  );
}

async function candidate(name: string, quote: number | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into supplier_candidates (org_id, sourcing_request_id, external_profile_url, display_name,
                                      quoted_price_minor, currency, turnaround_days)
     values ($1, $2, $3, $4, $5, $6, 14) returning id`,
    [ORG, requestId, `https://example.test/${name}`, name, quote, quote === null ? null : 'ZAR'],
  );
  return rows[0]!.id;
}

const evaluations = async (estimateId: string) =>
  (
    await db.query<{
      supplier_cost_minor: string;
      platform_fee_minor: string;
      margin_minor: string;
      margin_pct: string;
      passed: boolean;
    }>(
      `select supplier_cost_minor::text, platform_fee_minor::text, margin_minor::text,
              margin_pct::text, passed
         from margin_evaluations where delivery_estimate_id = $1`,
      [estimateId],
    )
  ).rows;

const repricedEvents = async (candidateId: string) =>
  (await listEvents(db, { type: 'margin.repriced' })).filter((e) => e.subject_id === candidateId);

async function lockedBrief(threadId: string): Promise<string> {
  const brief = await insertBriefVersion(db, {
    orgId: ORG,
    threadId,
    brief: {
      title: 'Shop',
      outcome: 'An online shop',
      users: null,
      mustHaves: ['Checkout'],
      later: [],
      references: [],
      assetsProvided: [],
      assetsMissing: [],
      techConstraints: [],
      deadline: null,
      deadlineFixed: null,
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      acceptanceCriteria: ['Orders go through'],
      signOff: { name: null, responseTime: null },
      risks: [],
      category: 'shopify',
      deliveryRoute: 'supplier',
    },
  });
  const locked = await lockBrief(db, brief, NOW);
  if (!locked.ok) throw new Error('fixture brief should lock');
  return locked.brief.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const r of identityRows('a')) await db.exec(r.sql);
  for (const r of tenantRows(ORG, 'a', 'a')) {
    if (['memberships', 'settings'].includes(r.table)) await db.exec(r.sql);
  }
  await db.query(
    `insert into service_categories (slug, name, sort_order) values ('shopify', 'Shopify', 4) on conflict (slug) do nothing`,
  );
  const job = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, budget_min_minor, budget_max_minor, currency)
     values ($1, 'freelancer', 'reprice-job', '{}'::jsonb, 'Shopify store rebuild', 300000, 500000, 'ZAR') returning id`,
    [ORG],
  );
  jobId = job.rows[0]!.id;
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle)
     values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG, jobId],
  );
  const r = await db.query<{ id: string }>(
    `insert into sourcing_requests (org_id, brief_id) values ($1, $2) returning id`,
    [ORG, await lockedBrief(t.rows[0]!.id)],
  );
  requestId = r.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('repricing with a candidate quote', () => {
  it('while a rule is unanswered, records the block and the rule, and judges nothing', async () => {
    await setRules(false);
    const id = await candidate('thandi-web', 300_000);
    const run = await repriceCandidate(deps(), { candidateId: id });
    expect(run).toMatchObject({ status: 'blocked', reason: 'rules_missing' });
    if (run.status !== 'blocked') return;
    expect(run.detail.join(' ')).toMatch(/D-02.*D-03.*T-02/);
    // The quote is kept as an estimate, with its method; no margin is written for it.
    const estimate = await db.query<{ method: string; expected_minor: string }>(
      `select method::text as method, expected_minor::text from delivery_estimates where id = $1`,
      [run.estimateId],
    );
    expect(estimate.rows[0]).toEqual({ method: 'candidate_quote', expected_minor: '300000' });
    expect(await evaluations(run.estimateId!)).toEqual([]);
    const [event] = await repricedEvents(id);
    expect(event).toMatchObject({ outcome: 'blocked' });
    expect(event?.payload).toMatchObject({ reason: 'rules_missing', candidate: 'thandi-web' });
    expect(alerts).toEqual([]);
  });

  it('with the rules set, prices the same quote and logs the margin before and after', async () => {
    await setRules(true);
    // The bid's first margin, from a rate card: R5 000,00 − R500,00 − R2 500,00 = R2 000,00 (40%).
    const rateCard = await db.query<{ id: string }>(
      `insert into delivery_estimates (org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor, created_at)
       values ($1, $2, 'shopify', 'rate_card', 'ZAR', 250000, 250000, 250000, now() - interval '1 hour') returning id`,
      [ORG, jobId],
    );
    expect(
      await evaluateJobMargin({ db }, { jobId, estimateId: rateCard.rows[0]!.id }),
    ).toMatchObject({ status: 'evaluated', passed: true });

    const [id] = (
      await db.query<{ id: string }>(
        `select id from supplier_candidates where display_name = 'thandi-web'`,
      )
    ).rows.map((r) => r.id);
    // R5 000,00 − R500,00 − R3 000,00 = R1 500,00, 30% of the budget: clears 20% and R500,00.
    const run = await repriceCandidate(deps(), { candidateId: id!, requestId: 'req-1' });
    expect(run).toMatchObject({ status: 'repriced', passed: true, alerted: false });
    if (run.status !== 'repriced') return;
    expect(await evaluations(run.estimateId)).toEqual([
      {
        supplier_cost_minor: '300000',
        platform_fee_minor: '50000',
        margin_minor: '150000',
        margin_pct: '30.000',
        passed: true,
      },
    ]);
    // The estimate blocked in the test above is the one judged now: one per quote.
    const estimates = await db.query(
      `select 1 from delivery_estimates where supplier_candidate_id = $1`,
      [id],
    );
    expect(estimates.rows).toHaveLength(1);
    const event = (await repricedEvents(id!)).find((e) => e.outcome === 'ok');
    expect(event?.request_id).toBe('req-1');
    expect(event?.payload).toMatchObject({
      quote_minor: '300000',
      currency: 'ZAR',
      before: { margin_minor: '200000', margin_pct: '40.000', passed: true },
      after: { evaluation_id: run.evaluationId, margin_minor: '150000', margin_pct: '30.000' },
    });
    expect(alerts).toEqual([]);
  });

  it('a quote that breaks the rule is stored as a failed margin and alerts the operator', async () => {
    // R5 000,00 − R500,00 − R4 200,00 = R300,00, 6%: below 20% and below R500,00.
    const id = await candidate('kolkata-devs', 420_000);
    const run = await repriceCandidate(deps(), { candidateId: id });
    expect(run).toMatchObject({ status: 'repriced', passed: false, alerted: true });
    if (run.status !== 'repriced') return;
    expect(await evaluations(run.estimateId)).toEqual([
      {
        supplier_cost_minor: '420000',
        platform_fee_minor: '50000',
        margin_minor: '30000',
        margin_pct: '6.000',
        passed: false,
      },
    ]);
    expect(alerts).toEqual([{ orgId: ORG, candidateId: id, evaluationId: run.evaluationId }]);
    const event = (await repricedEvents(id)).find((e) => e.outcome === 'ok');
    expect(event?.payload).toMatchObject({
      before: { margin_minor: '150000' },
      after: { margin_minor: '30000', passed: false },
    });
  });

  it('the same quote again changes nothing; a new quote is priced again', async () => {
    const [id] = (
      await db.query<{ id: string }>(
        `select id from supplier_candidates where display_name = 'kolkata-devs'`,
      )
    ).rows.map((r) => r.id);
    alerts.length = 0;
    expect(await repriceCandidate(deps(), { candidateId: id! })).toMatchObject({
      status: 'skipped',
      reason: 'unchanged',
    });
    expect(alerts).toEqual([]);

    // R3 500,00: R5 000,00 − R500,00 − R3 500,00 = R1 000,00, exactly 20%: the rule is met.
    await db.query(`update supplier_candidates set quoted_price_minor = 350000 where id = $1`, [
      id,
    ]);
    const run = await repriceCandidate(deps(), { candidateId: id! });
    expect(run).toMatchObject({ status: 'repriced', passed: true, alerted: false });
    if (run.status !== 'repriced') return;
    expect(await evaluations(run.estimateId)).toMatchObject([
      { margin_minor: '100000', margin_pct: '20.000', passed: true },
    ]);
    const count = await db.query(
      `select 1 from delivery_estimates where supplier_candidate_id = $1`,
      [id],
    );
    expect(count.rows).toHaveLength(2);
  });

  it('a bid on our own Freelancer.com project costs its quote plus the employer fee, and blocks without that rule', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into supplier_candidates (org_id, sourcing_request_id, external_bid_id, display_name,
                                        country_code, quoted_price_minor, currency, turnaround_days)
       values ($1, $2, '901', 'bidder-901', 'ZA', 300000, 'ZAR', 7) returning id`,
      [ORG, requestId],
    );
    const bid = rows[0]!.id;
    // The fee table has only the freelancer side: the employer's rule is missing, and named.
    const blocked = await repriceCandidate(deps(), { candidateId: bid });
    expect(blocked).toMatchObject({
      status: 'blocked',
      reason: 'fee_rule_missing',
      estimateId: null,
    });
    if (blocked.status === 'blocked') expect(blocked.detail[0]).toMatch(/employer side.*T-02/);
    const none = await db.query(
      `select 1 from delivery_estimates where supplier_candidate_id = $1`,
      [bid],
    );
    expect(none.rows).toEqual([]);

    // Test employer rule: 3% with a R10,00 minimum. 3% of R3 000,00 is R90,00, above it:
    // cost R3 090,00; margin R5 000,00 − R500,00 − R3 090,00 = R1 410,00, 28,2%: passes.
    await db.query(`update settings set fee_table = $2::jsonb where org_id = $1`, [
      ORG,
      JSON.stringify([
        ...FEE_TABLE,
        {
          platform: 'freelancer',
          project_type: 'fixed',
          side: 'employer',
          percent: 3,
          min_minor: 1000,
          min_currency: 'ZAR',
          source_url: 'https://example.test/fees',
          read_on: '2026-09-22',
        },
      ]),
    ]);
    const run = await repriceCandidate(deps(), { candidateId: bid });
    expect(run).toMatchObject({ status: 'repriced', passed: true });
    if (run.status !== 'repriced') return;
    expect(await evaluations(run.estimateId)).toEqual([
      {
        supplier_cost_minor: '309000',
        platform_fee_minor: '50000',
        margin_minor: '141000',
        margin_pct: '28.200',
        passed: true,
      },
    ]);
    const event = (await repricedEvents(bid)).find((e) => e.outcome === 'ok');
    expect(event?.payload).toMatchObject({
      quote_minor: '300000',
      cost_minor: '309000',
      employer_fee: {
        employer_fee_minor: 9000,
        minimum_applied: false,
        percent: 3,
        source_url: 'https://example.test/fees',
      },
    });
  });

  it('a candidate with no quote, or a brief with no job behind it, is skipped and says why', async () => {
    const noQuote = await candidate('no-quote-yet', null);
    expect(await repriceCandidate(deps(), { candidateId: noQuote })).toMatchObject({
      status: 'skipped',
      reason: 'no_quote',
    });

    const t = await db.query<{ id: string }>(
      `insert into threads (org_id, platform, external_thread_id, client_handle)
       values ($1, 'freelancer', '5002', 'direct-client') returning id`,
      [ORG],
    );
    const r = await db.query<{ id: string }>(
      `insert into sourcing_requests (org_id, brief_id) values ($1, $2) returning id`,
      [ORG, await lockedBrief(t.rows[0]!.id)],
    );
    const orphan = await db.query<{ id: string }>(
      `insert into supplier_candidates (org_id, sourcing_request_id, external_profile_url, display_name,
                                        quoted_price_minor, currency)
       values ($1, $2, 'https://example.test/x', 'x', 100000, 'ZAR') returning id`,
      [ORG, r.rows[0]!.id],
    );
    const run = await repriceCandidate(deps(), { candidateId: orphan.rows[0]!.id });
    expect(run).toMatchObject({ status: 'skipped', reason: 'no_job' });
    if (run.status === 'skipped') expect(run.message).toMatch(/no job/);

    await expect(
      repriceCandidate(deps(), { candidateId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
