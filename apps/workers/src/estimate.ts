import {
  CLASSIFY_SYSTEM_PROMPT,
  buildCategorySchema,
  buildClassifyPrompt,
  chooseEstimate,
  type EstimateMethod,
  type ModelCategory,
  type PriceBandSource,
  type RateCardSource,
} from '@arbitron/core';
import { recordEvent, recordLlmCall, type Queryable } from '@arbitron/db';
import { LlmOutputError, completeJson, type LlmTransport } from '@arbitron/llm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { enqueueMargin } from './margin.js';

/**
 * The estimate worker (ARB-040, docs/01 section E): "Classifies category; estimate order:
 * in-house capability → supplier rate card → market band p50 → AI-build tier (website
 * categories only)". Writes `delivery_estimates`.
 *
 * The category is asked of the model once and kept on the job; the price is never asked
 * of the model at all. It comes from the owner's own rows through `chooseEstimate`, and
 * when there is no such row the job gets no estimate and an event saying why — not a
 * number from nowhere.
 */
export interface EstimateJobData {
  readonly jobId: string;
  readonly requestId?: string;
}

export interface EstimateDeps {
  /** A service-role connection: the worker acts for whichever org owns the job. */
  readonly db: Queryable;
  readonly transport: LlmTransport;
  readonly model: string;
  /** Where an estimate goes next: "margin — trigger: after estimate" (01 section E). Optional, as in the scorer. */
  readonly marginQueue?: Queue;
}

export type EstimateSkipReason =
  'no_score' | 'verdict_skip' | 'no_currency' | 'no_category' | 'no_source';

export type EstimateResult =
  | {
      readonly status: 'estimated';
      readonly estimateId: string;
      readonly method: EstimateMethod;
      readonly categorySlug: string;
    }
  | { readonly status: 'already_estimated'; readonly estimateId: string }
  | { readonly status: 'skipped'; readonly reason: EstimateSkipReason };

interface JobRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  skills: string[];
  currency: string | null;
  hourly: boolean;
  category_slug: string | null;
  category_confidence: string | null;
}

interface CategoryRow {
  slug: string;
  name: string;
  in_house: boolean;
}

interface RateCardRow {
  supplier_id: string;
  supplier_name: string;
  channel: RateCardSource['channel'];
  currency: string;
  fixed_price_minor: string | null;
  hourly_rate_minor: string | null;
  turnaround_days: number | null;
}

interface BandRow {
  id: string;
  currency: string;
  p25_minor: string;
  p50_minor: string;
  p75_minor: string;
  sample_size: number;
  source: PriceBandSource['source'];
  sampled_at: string;
}

async function inTransaction<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const result = await work();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function skip(
  db: Queryable,
  job: JobRow,
  requestId: string | null,
  reason: EstimateSkipReason,
  detail: Record<string, unknown> = {},
): Promise<EstimateResult> {
  await recordEvent(db, {
    orgId: job.org_id,
    type: 'estimate.created',
    subjectTable: 'jobs',
    subjectId: job.id,
    requestId,
    outcome: 'skipped',
    payload: { jobId: job.id, reason, ...detail },
  });
  return { status: 'skipped', reason };
}

/**
 * The job's category: read back if it is already known, otherwise asked of the model
 * once, metered, and stored on the job so it is never paid for twice.
 */
async function classify(
  deps: EstimateDeps,
  job: JobRow,
  requestId: string | null,
): Promise<{ slug: string | null; confidence: number | null; reason: string | null }> {
  if (job.category_slug) {
    return {
      slug: job.category_slug,
      confidence: job.category_confidence === null ? null : Number(job.category_confidence),
      reason: null,
    };
  }
  const { db } = deps;
  const categories = await db.query<CategoryRow>(
    'select slug, name, in_house from service_categories order by sort_order, slug',
  );

  let result;
  try {
    result = await completeJson<ModelCategory>({
      transport: deps.transport,
      model: deps.model,
      schema: buildCategorySchema(categories.rows.map((row) => row.slug)),
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: buildClassifyPrompt(
        { title: job.title, description: job.description, skills: job.skills },
        categories.rows,
      ),
      retries: 1,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      await inTransaction(db, async () => {
        await recordLlmCall(db, {
          orgId: job.org_id,
          purpose: 'estimate',
          model: deps.model,
          subjectTable: 'jobs',
          subjectId: job.id,
          requestId,
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          costNanoUsd: error.costNanoUsd,
          attempts: error.attempts,
          outcome: 'invalid_output',
          problems: error.problems,
        });
        await recordEvent(db, {
          orgId: job.org_id,
          type: 'estimate.created',
          subjectTable: 'jobs',
          subjectId: job.id,
          requestId,
          outcome: 'error',
          payload: { reason: 'invalid_output', attempts: error.attempts, problems: error.problems },
        });
      });
      throw new UnrecoverableError(`job ${job.id}: ${error.message}`);
    }
    await recordEvent(db, {
      orgId: job.org_id,
      type: 'estimate.created',
      subjectTable: 'jobs',
      subjectId: job.id,
      requestId,
      outcome: 'error',
      payload: { reason: 'transport', message: (error as Error).message },
    });
    throw error;
  }

  const { category_slug: slug, confidence, reason } = result.value;
  await inTransaction(db, async () => {
    await recordLlmCall(db, {
      orgId: job.org_id,
      purpose: 'estimate',
      model: result.model,
      subjectTable: 'jobs',
      subjectId: job.id,
      requestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens ?? 0,
      cacheWriteTokens:
        (result.usage.cacheWrite5mTokens ?? 0) + (result.usage.cacheWrite1hTokens ?? 0),
      costNanoUsd: result.costNanoUsd,
      attempts: result.attempts,
      outcome: 'ok',
      problems: result.problems,
    });
    if (slug) {
      await db.query('update jobs set category_slug = $2, category_confidence = $3 where id = $1', [
        job.id,
        slug,
        confidence,
      ]);
    }
  });
  return { slug, confidence, reason };
}

async function loadSources(db: Queryable, orgId: string, slug: string, currency: string) {
  const category = await db.query<CategoryRow>(
    'select slug, name, in_house from service_categories where slug = $1',
    [slug],
  );
  const cards = await db.query<RateCardRow>(
    `select s.id as supplier_id, s.name as supplier_name, s.channel, rc.currency,
            rc.fixed_price_minor::text, rc.hourly_rate_minor::text, rc.turnaround_days
     from supplier_rate_cards rc
     join suppliers s on s.id = rc.supplier_id
     where rc.org_id = $1 and rc.category_slug = $2 and rc.currency = $3 and s.active
     order by s.name`,
    [orgId, slug, currency],
  );
  const bands = await db.query<BandRow>(
    `select id, currency, p25_minor::text, p50_minor::text, p75_minor::text, sample_size,
            source, sampled_at::text
     from market_price_bands where category_slug = $1 and currency = $2`,
    [slug, currency],
  );
  const num = (value: string | null): number | null => (value === null ? null : Number(value));
  return {
    category: category.rows[0] ?? null,
    rateCards: cards.rows.map((row): RateCardSource => ({
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      channel: row.channel,
      currency: row.currency,
      fixedPriceMinor: num(row.fixed_price_minor),
      hourlyRateMinor: num(row.hourly_rate_minor),
      turnaroundDays: row.turnaround_days,
    })),
    bands: bands.rows.map((row): PriceBandSource => ({
      id: row.id,
      currency: row.currency,
      p25Minor: Number(row.p25_minor),
      p50Minor: Number(row.p50_minor),
      p75Minor: Number(row.p75_minor),
      sampleSize: row.sample_size,
      source: row.source,
      sampledAt: new Date(row.sampled_at).toISOString(),
    })),
  };
}

export async function estimateJob(
  deps: EstimateDeps,
  data: EstimateJobData,
): Promise<EstimateResult> {
  const { db } = deps;
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<JobRow>(
    `select id, org_id, title, description, skills, currency, hourly, category_slug,
            category_confidence::text
     from jobs where id = $1`,
    [data.jobId],
  );
  const job = rows[0];
  if (!job) throw new UnrecoverableError(`job ${data.jobId} does not exist`);

  // Idempotent: a redelivered job keeps the estimate it has. A candidate's quote (the
  // reprice worker's work) is a different estimate and does not count here.
  const existing = await db.query<{ id: string }>(
    `select id from delivery_estimates
     where job_id = $1 and method <> 'candidate_quote' order by created_at limit 1`,
    [job.id],
  );
  if (existing.rows[0]) return { status: 'already_estimated', estimateId: existing.rows[0].id };

  // The trigger is "score verdict ≠ skip": a job the scorer turned away is not priced.
  const score = await db.query<{ verdict: string }>(
    'select verdict from job_scores where job_id = $1 order by created_at desc limit 1',
    [job.id],
  );
  const verdict = score.rows[0]?.verdict;
  if (!verdict) return skip(db, job, requestId, 'no_score');
  if (verdict === 'skip') return skip(db, job, requestId, 'verdict_skip');

  // Sources are read in the job's currency, so a job without one cannot be priced. Checked
  // before the model is asked, so the classification is not paid for in vain.
  const currency = job.currency?.trim() ?? '';
  if (!currency) return skip(db, job, requestId, 'no_currency');

  const category = await classify(deps, job, requestId);
  if (!category.slug) {
    return skip(db, job, requestId, 'no_category', {
      confidence: category.confidence,
      modelReason: category.reason,
    });
  }

  const sources = await loadSources(db, job.org_id, category.slug, currency);
  if (!sources.category) throw new UnrecoverableError(`category ${category.slug} does not exist`);
  const decision = chooseEstimate({
    category: { slug: sources.category.slug, inHouse: sources.category.in_house },
    currency,
    hourly: job.hourly,
    rateCards: sources.rateCards,
    bands: sources.bands,
  });
  if (!decision.choice) {
    return skip(db, job, requestId, 'no_source', {
      categorySlug: category.slug,
      currency,
      hourly: job.hourly,
      considered: decision.considered,
    });
  }
  const { choice } = decision;

  const estimateId = await inTransaction(db, async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into delivery_estimates
         (org_id, job_id, category_slug, method, currency, low_minor, expected_minor,
          high_minor, turnaround_days, supplier_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        job.org_id,
        job.id,
        category.slug,
        choice.method,
        choice.currency,
        choice.lowMinor,
        choice.expectedMinor,
        choice.highMinor,
        choice.turnaroundDays,
        choice.supplierId,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`job ${job.id}: the estimate was not stored`);
    await recordEvent(db, {
      orgId: job.org_id,
      type: 'estimate.created',
      subjectTable: 'delivery_estimates',
      subjectId: id,
      requestId,
      outcome: 'ok',
      payload: {
        jobId: job.id,
        categorySlug: category.slug,
        categoryConfidence: category.confidence,
        method: choice.method,
        priced: job.hourly ? 'per_hour' : 'fixed',
        currency: choice.currency,
        lowMinor: choice.lowMinor,
        expectedMinor: choice.expectedMinor,
        highMinor: choice.highMinor,
        turnaroundDays: choice.turnaroundDays,
        basis: choice.basis,
        considered: decision.considered,
      },
    });
    return id;
  });

  // Only once the estimate is committed, so a margin can never be judged before its estimate.
  if (deps.marginQueue) {
    await enqueueMargin(deps.marginQueue, {
      jobId: job.id,
      estimateId,
      ...(requestId ? { requestId } : {}),
    });
  }

  return { status: 'estimated', estimateId, method: choice.method, categorySlug: category.slug };
}

export function createEstimateProcessor(deps: EstimateDeps) {
  return (job: Job<EstimateJobData>): Promise<EstimateResult> => estimateJob(deps, job.data);
}

/** One estimate job per `jobs` row: BullMQ drops an add whose id is already queued. */
export function enqueueEstimate(queue: Queue, data: EstimateJobData) {
  return queue.add('estimate', data, { jobId: `estimate__${data.jobId}` });
}
