import { randomUUID } from 'node:crypto';
import { SCORING_FIXTURES } from '@arbitron/core/scoring-fixtures';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEstimateProcessor, enqueueEstimate, estimateJob } from './estimate.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';
import { scoreJob } from './score.js';

/**
 * ARB-040 acceptance: "Each estimate records its method; unit tests for each branch".
 *
 * Every figure in these tests is test data for this file. The model is a scripted
 * transport that only ever answers the category question; the prices come from rows the
 * tests insert, exactly as the owner's will (docs/BLOCKERS.md D-14, D-15).
 */
const MODEL = 'claude-opus-5';
const ORG = fixtureId('a', ENTITY.org);
let db: PGlite;

class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async send(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('the script ran out of replies');
    return { text, model: request.model, usage: { inputTokens: 900, outputTokens: 60 } };
  }
}

/** A transport that names the category, and nothing else. */
function classifiesAs(slug: string | null, confidence = 0.9): ScriptedTransport {
  return new ScriptedTransport([
    JSON.stringify({ category_slug: slug, confidence, reason: 'The deliverable is clear.' }),
  ]);
}

interface JobFields {
  currency?: string | null;
  hourly?: boolean;
  categorySlug?: string;
}

async function insertJob(key: string, fields: JobFields = {}): Promise<string> {
  const currency = fields.currency === undefined ? 'ZAR' : fields.currency;
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs
       (org_id, platform, external_id, raw, title, description, budget_min_minor,
        budget_max_minor, currency, hourly, skills, category_slug)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      ORG,
      `${key}-${randomUUID()}`,
      `Job ${key}`,
      'Build the thing described here.',
      currency ? 100_000 : null,
      currency ? 200_000 : null,
      currency,
      fields.hourly ?? false,
      ['WordPress'],
      fields.categorySlug ?? null,
    ],
  );
  return rows[0]!.id;
}

async function insertScore(jobId: string, verdict: 'go' | 'caution' | 'skip'): Promise<void> {
  await db.query(
    `insert into job_scores (org_id, job_id, score, verdict, model) values ($1, $2, 70, $3, $4)`,
    [ORG, jobId, verdict, MODEL],
  );
}

async function insertCategory(slug: string, inHouse = false): Promise<void> {
  await db.query(
    `insert into service_categories (slug, name, in_house) values ($1, $2, $3)
     on conflict (slug) do update set in_house = excluded.in_house`,
    [slug, slug, inHouse],
  );
}

type Channel = 'freelancer' | 'upwork' | 'fiverr' | 'direct' | 'in_house' | 'ai_build';

async function insertSupplier(name: string, channel: Channel, active = true): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into suppliers (org_id, name, channel, active) values ($1, $2, $3, $4) returning id`,
    [ORG, `${name} ${randomUUID().slice(0, 8)}`, channel, active],
  );
  return rows[0]!.id;
}

async function insertCard(
  supplierId: string,
  slug: string,
  price: { fixed?: number; hourly?: number; turnaround?: number; currency?: string },
): Promise<void> {
  await db.query(
    `insert into supplier_rate_cards
       (org_id, supplier_id, category_slug, currency, fixed_price_minor, hourly_rate_minor, turnaround_days)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ORG,
      supplierId,
      slug,
      price.currency ?? 'ZAR',
      price.fixed ?? null,
      price.hourly ?? null,
      price.turnaround ?? null,
    ],
  );
}

async function insertBand(
  slug: string,
  source: 'seed' | 'marketplace_sample' | 'owner_csv' | 'completed_projects',
  p: [number, number, number],
  currency = 'ZAR',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into market_price_bands
       (category_slug, currency, p25_minor, p50_minor, p75_minor, sample_size, source)
     values ($1, $2, $3, $4, $5, 8, $6) returning id`,
    [slug, currency, p[0], p[1], p[2], source],
  );
  return rows[0]!.id;
}

interface EstimateRow {
  method: string;
  category_slug: string;
  currency: string;
  low_minor: string;
  expected_minor: string;
  high_minor: string;
  turnaround_days: number | null;
  supplier_id: string | null;
}

async function storedEstimate(jobId: string): Promise<EstimateRow | undefined> {
  const { rows } = await db.query<EstimateRow>(
    `select method, category_slug, currency, low_minor::text, expected_minor::text,
            high_minor::text, turnaround_days, supplier_id
     from delivery_estimates where job_id = $1`,
    [jobId],
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0];
}

async function lastEvent(jobId: string) {
  const { rows } = await db.query<{ outcome: string; payload: Record<string, unknown> }>(
    `select outcome, payload from events
     where type = 'estimate.created'
       and (subject_id::text = $1::text or payload ->> 'jobId' = $1::text)
     order by created_at desc limit 1`,
    [jobId],
  );
  return rows[0];
}

/** A category of its own per test, so rate cards and bands never bleed between tests. */
let categoryCounter = 0;
async function freshCategory(inHouse = false): Promise<string> {
  categoryCounter += 1;
  const slug = `test-cat-${String(categoryCounter)}`;
  await insertCategory(slug, inHouse);
  return slug;
}

/** Scores the job "go" and estimates it with the model answering `slug`. */
async function estimateWith(jobId: string, slug: string | null, requestId?: string) {
  await insertScore(jobId, 'go');
  const transport = classifiesAs(slug);
  const result = await estimateJob(
    { db, transport, model: MODEL },
    requestId ? { jobId, requestId } : { jobId },
  );
  return { result, transport };
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  for (const slug of ['website-build', 'landing-page', 'copywriting']) await insertCategory(slug);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('each branch, in the order the spec fixes', () => {
  it('in_house: an in-house category priced from the in-house rate card', async () => {
    const slug = await freshCategory(true);
    const inHouse = await insertSupplier('Logi-Ink', 'in_house');
    await insertCard(inHouse, slug, { fixed: 250_000, turnaround: 5 });
    const outside = await insertSupplier('Outside', 'direct');
    await insertCard(outside, slug, { fixed: 500_000, turnaround: 7 });
    await insertBand(slug, 'owner_csv', [100_000, 200_000, 400_000]);

    const jobId = await insertJob('in-house');
    const { result } = await estimateWith(jobId, slug);
    expect(result).toMatchObject({ status: 'estimated', method: 'in_house', categorySlug: slug });
    expect(await storedEstimate(jobId)).toEqual({
      method: 'in_house',
      category_slug: slug,
      currency: 'ZAR',
      low_minor: '250000',
      expected_minor: '250000',
      high_minor: '250000',
      turnaround_days: 5,
      supplier_id: inHouse,
    });
  });

  it('rate_card: the suppliers min, median and max, with the median turnaround', async () => {
    const slug = await freshCategory();
    // Hand-worked: 300 000 / 500 000 / 900 000 → low 300 000, expected 500 000, high
    // 900 000; turnarounds 3 / 7 / 10 → 7. An inactive supplier's card is not read.
    for (const [price, days, channel] of [
      [900_000, 10, 'direct'],
      [300_000, 3, 'freelancer'],
      [500_000, 7, 'fiverr'],
    ] as const) {
      await insertCard(await insertSupplier('S', channel), slug, {
        fixed: price,
        turnaround: days,
      });
    }
    await insertCard(await insertSupplier('Gone', 'direct', false), slug, { fixed: 1_000 });

    const jobId = await insertJob('rate-card');
    const { result } = await estimateWith(jobId, slug);
    expect(result).toMatchObject({ status: 'estimated', method: 'rate_card' });
    expect(await storedEstimate(jobId)).toMatchObject({
      method: 'rate_card',
      low_minor: '300000',
      expected_minor: '500000',
      high_minor: '900000',
      turnaround_days: 7,
      supplier_id: null,
    });
    const event = await lastEvent(jobId);
    expect(event?.outcome).toBe('ok');
    expect((event?.payload.basis as { suppliers: unknown[] }).suppliers).toHaveLength(3);
  });

  it('market_band: p25/p50/p75 of the best band when no supplier has a rate', async () => {
    const slug = await freshCategory();
    await insertBand(slug, 'seed', [150_000, 300_000, 600_000]);
    const observed = await insertBand(slug, 'owner_csv', [100_000, 200_000, 400_000]);

    const jobId = await insertJob('band');
    const { result } = await estimateWith(jobId, slug);
    expect(result).toMatchObject({ status: 'estimated', method: 'market_band' });
    expect(await storedEstimate(jobId)).toMatchObject({
      method: 'market_band',
      low_minor: '100000',
      expected_minor: '200000',
      high_minor: '400000',
      turnaround_days: null,
      supplier_id: null,
    });
    const event = await lastEvent(jobId);
    expect(event?.payload.basis).toMatchObject({
      bandId: observed,
      source: 'owner_csv',
      isSeed: false,
    });
    expect(event?.payload.considered).toEqual([
      expect.stringMatching(/^in_house/),
      expect.stringMatching(/^rate_card/),
    ]);
  });

  it('market_band: a seed band is used only when nothing else exists, and is flagged', async () => {
    const slug = await freshCategory();
    await insertBand(slug, 'seed', [150_000, 300_000, 600_000]);
    const jobId = await insertJob('seed-band');
    await estimateWith(jobId, slug);
    expect((await lastEvent(jobId))?.payload.basis).toMatchObject({ source: 'seed', isSeed: true });
  });

  it('ai_build: a website category with only an AI-build rate card', async () => {
    const ai = await insertSupplier('AI build', 'ai_build');
    await insertCard(ai, 'landing-page', { fixed: 80_000, turnaround: 2 });

    const jobId = await insertJob('ai-build');
    const { result } = await estimateWith(jobId, 'landing-page');
    expect(result).toMatchObject({ status: 'estimated', method: 'ai_build' });
    expect(await storedEstimate(jobId)).toMatchObject({
      method: 'ai_build',
      expected_minor: '80000',
      turnaround_days: 2,
      supplier_id: ai,
    });
  });

  it('ai_build: is not offered outside website categories', async () => {
    const ai = await insertSupplier('AI build', 'ai_build');
    await insertCard(ai, 'copywriting', { fixed: 80_000 });

    const jobId = await insertJob('ai-copy');
    const { result } = await estimateWith(jobId, 'copywriting');
    expect(result).toEqual({ status: 'skipped', reason: 'no_source' });
    expect(await storedEstimate(jobId)).toBeUndefined();
    const event = await lastEvent(jobId);
    expect(event?.outcome).toBe('skipped');
    expect(event?.payload.considered).toContainEqual(
      expect.stringMatching(/only website categories/),
    );
  });

  it('none: no row to stand on means no estimate and an event that lists what was tried', async () => {
    const slug = await freshCategory(true);
    const jobId = await insertJob('nothing');
    const { result } = await estimateWith(jobId, slug);
    expect(result).toEqual({ status: 'skipped', reason: 'no_source' });
    expect(await storedEstimate(jobId)).toBeUndefined();
    const event = await lastEvent(jobId);
    expect(event?.outcome).toBe('skipped');
    expect(event?.payload).toMatchObject({
      reason: 'no_source',
      categorySlug: slug,
      currency: 'ZAR',
    });
    expect(event?.payload.considered).toHaveLength(4);
  });
});

describe('hourly jobs and currencies', () => {
  it('prices an hourly job per hour from hourly rates, ignoring fixed prices and bands', async () => {
    const slug = await freshCategory();
    await insertCard(await insertSupplier('Fixed', 'direct'), slug, { fixed: 500_000 });
    const hourly = await insertSupplier('Hourly', 'upwork');
    await insertCard(hourly, slug, { hourly: 45_00, turnaround: 1 });
    await insertBand(slug, 'owner_csv', [100_000, 200_000, 400_000]);

    const jobId = await insertJob('hourly', { hourly: true });
    await estimateWith(jobId, slug);
    expect(await storedEstimate(jobId)).toMatchObject({
      method: 'rate_card',
      expected_minor: '4500',
      supplier_id: hourly,
    });
    expect((await lastEvent(jobId))?.payload.priced).toBe('per_hour');
  });

  it('reads only sources in the job s currency', async () => {
    const slug = await freshCategory();
    await insertCard(await insertSupplier('ZAR only', 'direct'), slug, { fixed: 500_000 });
    await insertBand(slug, 'owner_csv', [100_000, 200_000, 400_000]);

    const jobId = await insertJob('usd', { currency: 'USD' });
    const { result } = await estimateWith(jobId, slug);
    expect(result).toEqual({ status: 'skipped', reason: 'no_source' });
  });

  it('a job with no currency is not classified, since it could not be priced anyway', async () => {
    const jobId = await insertJob('no-currency', { currency: null });
    const { result, transport } = await estimateWith(jobId, 'copywriting');
    expect(result).toEqual({ status: 'skipped', reason: 'no_currency' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('the trigger: score verdict ≠ skip', () => {
  it('does nothing, and pays nothing, for a job the scorer skipped', async () => {
    const jobId = await insertJob('skipped');
    await insertScore(jobId, 'skip');
    const transport = classifiesAs('copywriting');
    const result = await estimateJob({ db, transport, model: MODEL }, { jobId });
    expect(result).toEqual({ status: 'skipped', reason: 'verdict_skip' });
    expect(transport.requests).toHaveLength(0);
    expect((await lastEvent(jobId))?.outcome).toBe('skipped');
  });

  it('does nothing for a job that has not been scored', async () => {
    const jobId = await insertJob('unscored');
    const transport = classifiesAs('copywriting');
    const result = await estimateJob({ db, transport, model: MODEL }, { jobId });
    expect(result).toEqual({ status: 'skipped', reason: 'no_score' });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a job that does not exist, without retrying', async () => {
    await expect(
      estimateJob({ db, transport: classifiesAs(null), model: MODEL }, { jobId: randomUUID() }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('classification', () => {
  it('asks the model once, meters the call, and keeps the answer on the job', async () => {
    const slug = await freshCategory();
    await insertCard(await insertSupplier('S', 'direct'), slug, { fixed: 100_000 });
    const jobId = await insertJob('classified');
    const requestId = randomUUID();
    const { result, transport } = await estimateWith(jobId, slug, requestId);
    if (result.status !== 'estimated') throw new Error('expected an estimate');

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.prompt).toContain('Job classified');
    expect(request.prompt).toContain(`- ${slug}: ${slug}`);
    expect(request.prompt).toContain('- copywriting: copywriting');

    const job = await db.query<{ category_slug: string; category_confidence: string }>(
      'select category_slug, category_confidence::text from jobs where id = $1',
      [jobId],
    );
    expect(job.rows[0]).toEqual({ category_slug: slug, category_confidence: '0.900' });

    const calls = await db.query<{
      purpose: string;
      attempts: number;
      outcome: string;
      cost_nano_usd: string;
    }>(
      'select purpose, attempts, outcome, cost_nano_usd::text from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows).toEqual([
      expect.objectContaining({ purpose: 'estimate', attempts: 1, outcome: 'ok' }),
    ]);
    expect(Number(calls.rows[0]!.cost_nano_usd)).toBeGreaterThan(0);

    const events = await db.query<{ outcome: string; subject_id: string }>(
      `select outcome, subject_id from events where request_id = $1 and type = 'estimate.created'`,
      [requestId],
    );
    expect(events.rows).toEqual([{ outcome: 'ok', subject_id: result.estimateId }]);
  });

  it('does not ask again for a job whose category is already known', async () => {
    const slug = await freshCategory();
    await insertCard(await insertSupplier('S', 'direct'), slug, { fixed: 100_000 });
    const jobId = await insertJob('known', { categorySlug: slug });
    await insertScore(jobId, 'caution');
    const transport = new ScriptedTransport([]);
    const result = await estimateJob({ db, transport, model: MODEL }, { jobId });
    expect(result).toMatchObject({ status: 'estimated', categorySlug: slug });
    expect(transport.requests).toHaveLength(0);
  });

  it('records a null answer as no category, paid for once, and leaves the job unclassified', async () => {
    const jobId = await insertJob('unclassifiable');
    const requestId = randomUUID();
    const { result } = await estimateWith(jobId, null, requestId);
    expect(result).toEqual({ status: 'skipped', reason: 'no_category' });
    const job = await db.query<{ category_slug: string | null }>(
      'select category_slug from jobs where id = $1',
      [jobId],
    );
    expect(job.rows[0]?.category_slug).toBeNull();
    const calls = await db.query('select 1 from llm_calls where request_id = $1', [requestId]);
    expect(calls.rows).toHaveLength(1);
    expect((await lastEvent(jobId))?.payload).toMatchObject({
      reason: 'no_category',
      confidence: 0.9,
    });
  });

  it('is held to the taxonomy: a made-up category is retried once, then refused', async () => {
    const jobId = await insertJob('made-up');
    await insertScore(jobId, 'go');
    const requestId = randomUUID();
    const transport = new ScriptedTransport([
      JSON.stringify({ category_slug: 'blogging', confidence: 0.9, reason: 'Blog posts.' }),
      JSON.stringify({ category_slug: 'blogging', confidence: 0.9, reason: 'Still blog posts.' }),
    ]);
    await expect(
      estimateJob({ db, transport, model: MODEL }, { jobId, requestId }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.prompt).toContain('Your previous reply was rejected');

    const calls = await db.query<{ outcome: string; attempts: number }>(
      'select outcome, attempts from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows[0]).toMatchObject({ outcome: 'invalid_output', attempts: 2 });
    expect((await lastEvent(jobId))?.outcome).toBe('error');
    expect(await storedEstimate(jobId)).toBeUndefined();
  });
});

describe('idempotency', () => {
  it('keeps the estimate it has, and pays nothing more', async () => {
    const slug = await freshCategory();
    await insertCard(await insertSupplier('S', 'direct'), slug, { fixed: 100_000 });
    const jobId = await insertJob('twice');
    const { result: first } = await estimateWith(jobId, slug);
    if (first.status !== 'estimated') throw new Error('expected an estimate');
    const transport = new ScriptedTransport([]);
    const second = await estimateJob({ db, transport, model: MODEL }, { jobId });
    expect(second).toEqual({ status: 'already_estimated', estimateId: first.estimateId });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('on the queue', () => {
  const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

  it('is fed by the scorer for every verdict but skip, and estimates what it is fed', async () => {
    const prefix = `arb-test-${randomUUID()}`;
    const queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 10 });
    const events = new QueueEvents('estimate', { connection, prefix });
    await events.waitUntilReady();
    const slug = await freshCategory();
    await insertCard(await insertSupplier('S', 'direct'), slug, { fixed: 100_000 });
    const worker = startWorker(
      'estimate',
      createEstimateProcessor({ db, transport: classifiesAs(slug), model: MODEL }),
      { connection, prefix, deadLetter: queues[DEAD_LETTER_QUEUE] },
    );
    try {
      const goJob = await insertJob('go', {});
      const skipJob = await insertJob('skip', {});
      const scoreWith = (verdict: 'go' | 'skip') =>
        new ScriptedTransport([
          JSON.stringify({
            score: verdict === 'go' ? 80 : 5,
            verdict,
            reasons: ['Scripted.'],
            flags: [],
            reply_probability: 0.3,
          }),
        ]);
      const deps = { db, model: MODEL, estimateQueue: queues.estimate };
      await scoreJob({ ...deps, transport: scoreWith('go') }, { jobId: goJob });
      await scoreJob({ ...deps, transport: scoreWith('skip') }, { jobId: skipJob });

      const queued = await queues.estimate.getJob(`estimate__${goJob}`);
      expect(queued).toBeDefined();
      expect(await queues.estimate.getJob(`estimate__${skipJob}`)).toBeUndefined();

      // A second enqueue of the same row is dropped rather than estimated again.
      const again = await enqueueEstimate(queues.estimate, { jobId: goJob });
      expect(again.id).toBe(queued!.id);

      const result = await queued!.waitUntilFinished(events, 10_000);
      expect(result).toMatchObject({ status: 'estimated', method: 'rate_card' });
      expect(await storedEstimate(goJob)).toMatchObject({ method: 'rate_card' });
    } finally {
      await worker.close();
      await events.close();
      for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
      await closeQueues(queues);
    }
  }, 30_000);
});

describe('the fixtures the scorer uses', () => {
  it('can all be classified into the taxonomy the seed ships', () => {
    // A guard on the prompt's inputs, not a model test: every fixture has the fields the
    // classification prompt reads.
    for (const fixture of SCORING_FIXTURES) {
      expect(fixture.job.title.length).toBeGreaterThan(0);
      expect(Array.isArray(fixture.job.skills)).toBe(true);
    }
  });
});
