import { randomUUID } from 'node:crypto';
import type { FxQuote } from '@arbitron/core';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, UnrecoverableError, type Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateJob } from './estimate.js';
import {
  createMarginProcessor,
  enqueueMargin,
  evaluateJobMargin,
  type FxRateSource,
} from './margin.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-041, the worker half: every input line stored, the rules copied in, the rate and
 * its time kept, and a missing rule recorded as a block rather than filled in.
 *
 * The fee table, the rules and the rate are this file's test data (docs/02 T-02, D-02,
 * D-03 and B-10 are open). The arithmetic itself is proved in packages/core.
 */
const ORG = fixtureId('a', ENTITY.org);
let db: PGlite;

/** Test fee table: 10% with a USD 5,00 minimum on fixed projects, 10% flat on hourly ones. */
const FEE_TABLE = [
  {
    platform: 'freelancer',
    project_type: 'fixed',
    side: 'freelancer',
    percent: 10,
    min_minor: 500,
    min_currency: 'USD',
    source_url: 'https://example.test/fees',
    read_on: '2026-09-22',
  },
  {
    platform: 'freelancer',
    project_type: 'hourly',
    side: 'freelancer',
    percent: 10,
    source_url: 'https://example.test/fees',
    read_on: '2026-09-22',
  },
];

class ScriptedFx implements FxRateSource {
  readonly asked: string[] = [];
  constructor(private readonly rates: Record<string, string>) {}
  quote(from: string, to: string): Promise<FxQuote> {
    this.asked.push(`${from}/${to}`);
    const rate = this.rates[`${from}/${to}`];
    if (!rate) return Promise.reject(new Error(`no scripted rate for ${from}/${to}`));
    return Promise.resolve({ rate, from, to, at: '2026-09-22T12:00:00.000Z', source: 'scripted' });
  }
}

interface RuleFields {
  minPct?: number | null;
  minZar?: number | null;
  buffer?: number | null;
  feeTable?: unknown;
}

/** Sets the org's rules for one test. Everything not named is cleared. */
async function setRules(fields: RuleFields): Promise<void> {
  await db.query(
    `update settings set min_margin_pct = $2, min_margin_zar_minor = $3, fx_buffer_pct = $4,
                         fee_table = $5::jsonb
     where org_id = $1`,
    [
      ORG,
      fields.minPct ?? null,
      fields.minZar ?? null,
      fields.buffer ?? null,
      JSON.stringify(fields.feeTable ?? []),
    ],
  );
}

const RULES: RuleFields = { minPct: 20, minZar: 50_000, buffer: 3, feeTable: FEE_TABLE };

/** The fee table's USD 5,00 minimum has to be converted even for a ZAR deal: R91,25 at 18.25. */
const usdZar = () => new ScriptedFx({ 'USD/ZAR': '18.25' });

/** The same table with no minimum on fixed projects, for deals that must need no rate at all. */
const FEE_TABLE_NO_MINIMUM = [
  { ...FEE_TABLE[0], min_minor: undefined, min_currency: undefined },
  FEE_TABLE[1],
];

interface JobFields {
  currency?: string | null;
  hourly?: boolean;
  budgetMin?: number | null;
  budgetMax?: number | null;
}

async function insertJob(key: string, fields: JobFields = {}): Promise<string> {
  const currency = fields.currency === undefined ? 'ZAR' : fields.currency;
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs
       (org_id, platform, external_id, raw, title, budget_min_minor, budget_max_minor, currency, hourly, skills)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, $4, $5, $6, $7, '{}')
     returning id`,
    [
      ORG,
      `${key}-${randomUUID()}`,
      `Job ${key}`,
      fields.budgetMin === undefined ? 100_000 : fields.budgetMin,
      fields.budgetMax === undefined ? 500_000 : fields.budgetMax,
      currency,
      fields.hourly ?? false,
    ],
  );
  return rows[0]!.id;
}

async function insertEstimate(
  jobId: string,
  expected: number,
  currency = 'ZAR',
  method = 'rate_card',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into delivery_estimates
       (org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor)
     values ($1, $2, 'web-design', $3, $4, $5, $5, $5) returning id`,
    [ORG, jobId, method, currency, expected],
  );
  return rows[0]!.id;
}

interface EvaluationRow {
  currency: string;
  client_budget_minor: string;
  platform_fee_minor: string;
  supplier_cost_minor: string;
  fx_buffer_minor: string;
  tool_cost_minor: string;
  margin_minor: string;
  margin_pct: string;
  min_margin_pct: string;
  min_margin_zar_minor: string;
  fx_rate_used: string | null;
  fx_rate_at: string | null;
  passed: boolean;
  reason: string;
  delivery_estimate_id: string;
}

async function storedEvaluations(jobId: string): Promise<EvaluationRow[]> {
  const { rows } = await db.query<EvaluationRow>(
    `select currency, client_budget_minor::text, platform_fee_minor::text, supplier_cost_minor::text,
            fx_buffer_minor::text, tool_cost_minor::text, margin_minor::text, margin_pct::text,
            min_margin_pct::text, min_margin_zar_minor::text, fx_rate_used::text, fx_rate_at::text,
            passed, reason, delivery_estimate_id
     from margin_evaluations where job_id = $1 order by created_at`,
    [jobId],
  );
  return rows;
}

async function lastEvent(jobId: string) {
  const { rows } = await db.query<{ outcome: string; payload: Record<string, unknown> }>(
    `select outcome, payload from events
     where type = 'margin.evaluated' and payload ->> 'jobId' = $1::text
     order by created_at desc limit 1`,
    [jobId],
  );
  return rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('a missing rule blocks, and is named; nothing is assumed in its place', () => {
  it('names every rule the owner has not set', async () => {
    await setRules({});
    const jobId = await insertJob('unset');
    await insertEstimate(jobId, 250_000);
    const result = await evaluateJobMargin({ db }, { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'rules_missing' });
    if (result.status !== 'blocked') return;
    expect(result.detail).toEqual([
      expect.stringMatching(/^min_margin_pct .*D-02/),
      expect.stringMatching(/^min_margin_zar_minor .*D-02/),
      expect.stringMatching(/^fx_buffer_pct .*D-03/),
      expect.stringMatching(/^fee_table .*T-02/),
    ]);
    expect(await storedEvaluations(jobId)).toEqual([]);
    const event = await lastEvent(jobId);
    expect(event?.outcome).toBe('blocked');
    expect(event?.payload.reason).toBe('rules_missing');
  });

  it('refuses a fee table without provenance', async () => {
    await setRules({ ...RULES, feeTable: [{ ...FEE_TABLE[0], source_url: undefined }] });
    const jobId = await insertJob('no-source');
    await insertEstimate(jobId, 250_000);
    const result = await evaluateJobMargin({ db }, { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'fee_table_invalid' });
    if (result.status === 'blocked') expect(result.detail[0]).toMatch(/source_url/);
  });

  it('blocks when the table has no rule for this platform and project type', async () => {
    await setRules({ ...RULES, feeTable: [FEE_TABLE[0]] });
    const jobId = await insertJob('no-hourly-rule', { hourly: true });
    await insertEstimate(jobId, 2_000);
    const result = await evaluateJobMargin({ db }, { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'fee_rule_missing' });
    if (result.status === 'blocked') expect(result.detail[0]).toMatch(/freelancer hourly/);
  });

  it('blocks a foreign-currency deal when there is no FX provider (B-10), and judges a ZAR deal without one', async () => {
    await setRules(RULES);
    const usd = await insertJob('usd-no-fx', { currency: 'USD', budgetMax: 200_000 });
    await insertEstimate(usd, 90_000, 'USD');
    const blocked = await evaluateJobMargin({ db }, { jobId: usd });
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'fx_unavailable' });
    if (blocked.status === 'blocked') expect(blocked.detail[0]).toMatch(/USD→ZAR.*B-10/);

    // A ZAR deal with a fee minimum in USD still needs that one rate.
    const zarMin = await insertJob('zar-usd-minimum');
    await insertEstimate(zarMin, 250_000);
    const minimum = await evaluateJobMargin({ db }, { jobId: zarMin });
    expect(minimum).toMatchObject({ status: 'blocked', reason: 'fx_unavailable' });
    if (minimum.status === 'blocked') expect(minimum.detail[0]).toMatch(/fee minimum is in USD/);

    // With no minimum to convert, a ZAR deal is judged with no provider at all.
    await setRules({ ...RULES, feeTable: FEE_TABLE_NO_MINIMUM });
    const zar = await insertJob('zar-no-fx');
    await insertEstimate(zar, 250_000);
    expect(await evaluateJobMargin({ db }, { jobId: zar })).toMatchObject({
      status: 'evaluated',
      passed: true,
    });
  });

  it('blocks when the estimate and the job disagree on currency', async () => {
    await setRules(RULES);
    const jobId = await insertJob('mismatch');
    await insertEstimate(jobId, 250_000, 'USD');
    const result = await evaluateJobMargin({ db }, { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'currency_mismatch' });
  });
});

describe('an evaluation stores every line', () => {
  it('for a fixed-price ZAR deal, with the rules copied in and no rate', async () => {
    // Budget R5 000,00; fee 10% = R500,00; supplier R2 500,00; margin R2 000,00 = 40.000%.
    await setRules(RULES);
    const jobId = await insertJob('zar');
    const estimateId = await insertEstimate(jobId, 250_000);
    const requestId = randomUUID();
    const fx = usdZar();
    const result = await evaluateJobMargin({ db, fx }, { jobId, estimateId, requestId });
    expect(result).toMatchObject({ status: 'evaluated', passed: true });
    // The provider was asked for the fee minimum only; a ZAR deal has no rate of its own.
    expect(fx.asked).toEqual(['USD/ZAR']);

    expect(await storedEvaluations(jobId)).toEqual([
      {
        currency: 'ZAR',
        client_budget_minor: '500000',
        platform_fee_minor: '50000',
        supplier_cost_minor: '250000',
        fx_buffer_minor: '0',
        tool_cost_minor: '0',
        margin_minor: '200000',
        margin_pct: '40.000',
        min_margin_pct: '20.000',
        min_margin_zar_minor: '50000',
        fx_rate_used: null,
        fx_rate_at: null,
        passed: true,
        reason: 'margin ZAR 2000.00 (40.000%) clears the rules',
        delivery_estimate_id: estimateId,
      },
    ]);

    const events = await db.query<{
      outcome: string;
      subject_id: string;
      payload: Record<string, unknown>;
    }>(
      `select outcome, subject_id, payload from events where request_id = $1 and type = 'margin.evaluated'`,
      [requestId],
    );
    expect(events.rows).toHaveLength(1);
    if (result.status !== 'evaluated') return;
    expect(events.rows[0]).toMatchObject({ outcome: 'ok', subject_id: result.evaluationId });
    expect(events.rows[0]?.payload).toMatchObject({
      requiredPriceMinor: 357_142,
      estimateMethod: 'rate_card',
      feeRule: { percent: 10, sourceUrl: 'https://example.test/fees', readOn: '2026-09-22' },
      fx: null,
    });
  });

  it('judges an Upwork job like any other, but hands nothing to the drafter', async () => {
    await setRules({
      ...RULES,
      feeTable: [...FEE_TABLE, { ...FEE_TABLE[0], platform: 'upwork' }],
    });
    const jobId = await insertJob('upwork-zar');
    await db.query(`update jobs set platform = 'upwork' where id = $1`, [jobId]);
    const estimateId = await insertEstimate(jobId, 250_000);
    const added: unknown[] = [];
    const draftQueue = {
      add: (name: string, data: unknown) => {
        added.push({ name, data });
        return Promise.resolve({ id: name });
      },
    } as unknown as Queue;
    const result = await evaluateJobMargin({ db, fx: usdZar(), draftQueue }, { jobId, estimateId });
    expect(result).toMatchObject({ status: 'evaluated', passed: true });
    expect(added).toEqual([]);
  });

  it('for a fixed-price USD deal, with the rate and its time', async () => {
    // Budget USD 2 000,00; fee 10% = 200,00; supplier 900,00; buffer 3% = 60,00;
    // margin USD 840,00 = 42.000%; at 18.25 that is ZAR 15 330,00.
    await setRules(RULES);
    const fx = new ScriptedFx({ 'USD/ZAR': '18.25' });
    const jobId = await insertJob('usd', { currency: 'USD', budgetMax: 200_000 });
    await insertEstimate(jobId, 90_000, 'USD');
    const result = await evaluateJobMargin({ db, fx }, { jobId });
    expect(result).toMatchObject({ status: 'evaluated', passed: true });
    expect(fx.asked).toEqual(['USD/ZAR']);

    const [row] = await storedEvaluations(jobId);
    expect(row).toMatchObject({
      currency: 'USD',
      platform_fee_minor: '20000',
      fx_buffer_minor: '6000',
      margin_minor: '84000',
      margin_pct: '42.000',
      fx_rate_used: '18.25000000',
      passed: true,
    });
    expect(new Date(row!.fx_rate_at!).toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect((await lastEvent(jobId))?.payload).toMatchObject({
      marginHomeMinor: 1_533_000,
      fx: { rate: '18.25', source: 'scripted' },
    });
  });

  it('converts a fee minimum quoted in another currency, asking the provider once per pair', async () => {
    // EUR deal, fee minimum USD 5,00 at USD 1 = EUR 0.90 → EUR 4,50 (450), above 10% of
    // a EUR 30,00 budget (300). Margin = 3 000 − 450 − 1 000 − 90 = EUR 14,60.
    await setRules(RULES);
    const fx = new ScriptedFx({ 'EUR/ZAR': '20.00', 'USD/EUR': '0.9' });
    const jobId = await insertJob('eur', { currency: 'EUR', budgetMin: null, budgetMax: 3_000 });
    await insertEstimate(jobId, 1_000, 'EUR');
    const result = await evaluateJobMargin({ db, fx }, { jobId });
    expect(result).toMatchObject({ status: 'evaluated' });
    expect(fx.asked.sort()).toEqual(['EUR/ZAR', 'USD/EUR']);
    expect((await storedEvaluations(jobId))[0]).toMatchObject({
      platform_fee_minor: '450',
      margin_minor: '1460',
    });
    expect((await lastEvent(jobId))?.payload).toMatchObject({ feeMinimumApplied: true });
  });

  it('for an hourly USD deal, judging the percentage only', async () => {
    // USD 45,00 per hour; fee 10% = 4,50; supplier 20,00; buffer 1,35 → USD 19,15 = 42.556%.
    await setRules(RULES);
    const fx = new ScriptedFx({ 'USD/ZAR': '18.25' });
    const jobId = await insertJob('hourly', {
      currency: 'USD',
      hourly: true,
      budgetMin: 3_000,
      budgetMax: 4_500,
    });
    await insertEstimate(jobId, 2_000, 'USD');
    const result = await evaluateJobMargin({ db, fx }, { jobId });
    expect(result).toMatchObject({ status: 'evaluated', passed: true });
    expect((await storedEvaluations(jobId))[0]).toMatchObject({
      client_budget_minor: '4500',
      platform_fee_minor: '450',
      fx_buffer_minor: '135',
      margin_minor: '1915',
      margin_pct: '42.556',
      reason: expect.stringMatching(/per hour/) as unknown,
    });
  });

  it('for a deal that fails, with the reason', async () => {
    // R2 000,00 budget; fee 10% = R200,00 (above the converted R91,25 minimum); supplier
    // R1 500,00 → margin R300,00 = 15.000%: under 20% and under R500.
    await setRules(RULES);
    const jobId = await insertJob('fails', { budgetMin: null, budgetMax: 200_000 });
    await insertEstimate(jobId, 150_000);
    const result = await evaluateJobMargin({ db, fx: usdZar() }, { jobId });
    expect(result).toMatchObject({ status: 'evaluated', passed: false });
    expect((await storedEvaluations(jobId))[0]).toMatchObject({
      platform_fee_minor: '20000',
      margin_minor: '30000',
      passed: false,
      reason:
        'margin 15.000% is below the 20.000% minimum; margin ZAR 300.00 is below the ZAR 500.00 minimum',
    });
  });

  it('records an error and lets the queue retry when the provider fails to answer', async () => {
    await setRules(RULES);
    const fx = new ScriptedFx({});
    const jobId = await insertJob('fx-down', { currency: 'USD' });
    await insertEstimate(jobId, 90_000, 'USD');
    await expect(evaluateJobMargin({ db, fx }, { jobId })).rejects.toThrow(/no scripted rate/);
    expect((await lastEvent(jobId))?.outcome).toBe('error');
    expect(await storedEvaluations(jobId)).toEqual([]);
  });
});

describe('what it skips', () => {
  it('a job with no estimate yet', async () => {
    await setRules(RULES);
    const jobId = await insertJob('no-estimate');
    expect(await evaluateJobMargin({ db }, { jobId })).toEqual({
      status: 'skipped',
      reason: 'no_estimate',
    });
    expect((await lastEvent(jobId))?.outcome).toBe('skipped');
  });

  it('a job with no budget to judge against', async () => {
    await setRules(RULES);
    const jobId = await insertJob('no-budget', { budgetMin: null, budgetMax: null });
    await insertEstimate(jobId, 250_000);
    expect(await evaluateJobMargin({ db }, { jobId })).toEqual({
      status: 'skipped',
      reason: 'no_budget',
    });
  });

  it('refuses a job that does not exist, without retrying', async () => {
    await expect(evaluateJobMargin({ db }, { jobId: randomUUID() })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('idempotency', () => {
  it('is one evaluation per estimate: a redelivery changes nothing, a new estimate is judged afresh', async () => {
    await setRules(RULES);
    const jobId = await insertJob('twice');
    const first = await insertEstimate(jobId, 250_000);
    const fx = usdZar();
    const a = await evaluateJobMargin({ db, fx }, { jobId, estimateId: first });
    const b = await evaluateJobMargin({ db, fx }, { jobId, estimateId: first });
    if (a.status !== 'evaluated') throw new Error('expected an evaluation');
    expect(b).toEqual({ status: 'already_evaluated', evaluationId: a.evaluationId });

    const second = await insertEstimate(jobId, 400_000, 'ZAR', 'candidate_quote');
    const c = await evaluateJobMargin({ db, fx }, { jobId, estimateId: second });
    expect(c).toMatchObject({ status: 'evaluated', passed: false });
    expect(await storedEvaluations(jobId)).toHaveLength(2);
  });
});

describe('on the queue', () => {
  const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

  it('is fed by the estimate worker and stores the evaluation', async () => {
    await setRules(RULES);
    const prefix = `arb-test-${randomUUID()}`;
    const queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 10 });
    const events = new QueueEvents('margin', { connection, prefix });
    await events.waitUntilReady();
    const worker = startWorker('margin', createMarginProcessor({ db, fx: usdZar() }), {
      connection,
      prefix,
      deadLetter: queues[DEAD_LETTER_QUEUE],
    });
    try {
      // The estimate worker, with its category already known and a rate card to read.
      const jobId = await insertJob('queued');
      await db.query(`update jobs set category_slug = 'web-design' where id = $1`, [jobId]);
      await db.query(
        `insert into job_scores (org_id, job_id, score, verdict, model) values ($1, $2, 70, 'go', 'm')`,
        [ORG, jobId],
      );
      const transport: LlmTransport = {
        send: (_: LlmRequest): Promise<LlmResponse> => Promise.reject(new Error('not asked')),
      };
      const estimated = await estimateJob(
        { db, transport, model: 'm', marginQueue: queues.margin },
        { jobId },
      );
      if (estimated.status !== 'estimated')
        throw new Error(`expected an estimate, got ${estimated.status}`);

      const queued = await queues.margin.getJob(`margin__${estimated.estimateId}`);
      expect(queued).toBeDefined();
      const again = await enqueueMargin(queues.margin, { jobId, estimateId: estimated.estimateId });
      expect(again.id).toBe(queued!.id);

      const result = await queued!.waitUntilFinished(events, 10_000);
      expect(result).toMatchObject({ status: 'evaluated' });
      expect((await storedEvaluations(jobId))[0]?.delivery_estimate_id).toBe(estimated.estimateId);
    } finally {
      await worker.close();
      await events.close();
      for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
      await closeQueues(queues);
    }
  }, 30_000);
});
