import {
  SCORE_SCHEMA,
  SCORE_SYSTEM_PROMPT,
  buildScorePrompt,
  detectRedFlags,
  reconcileScore,
  type FinalScore,
  type ModelScore,
  type ScorableJob,
} from '@arbitron/core';
import { recordEvent, recordLlmCall, type Queryable } from '@arbitron/db';
import { LlmOutputError, completeJson, type LlmTransport } from '@arbitron/llm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';

/**
 * The score worker (ARB-032, docs/01 section E): "LLM scoring against strict JSON
 * schema; rejects invalid output and retries once".
 *
 * The one retry is `completeJson`'s, with the validation errors fed back. A second bad
 * reply is final — the job goes to the dead-letter queue rather than round the queue's
 * own backoff, which would pay for the same bad answer three more times. A transport
 * failure is different: nothing was judged, so the queue retries it as usual.
 */
export interface ScoreJobData {
  readonly jobId: string;
  readonly requestId?: string;
}

export interface ScoreDeps {
  /** A service-role connection: the worker acts for whichever org owns the job. */
  readonly db: Queryable;
  readonly transport: LlmTransport;
  readonly model: string;
}

export type ScoreResult =
  | { readonly status: 'scored'; readonly scoreId: string; readonly score: FinalScore }
  | { readonly status: 'already_scored'; readonly scoreId: string };

interface JobRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  budget_min_minor: string | null;
  budget_max_minor: string | null;
  currency: string | null;
  hourly: boolean;
  skills: string[];
  client_country: string | null;
  client_payment_verified: boolean | null;
  client_spend_minor: string | null;
  client_rating: string | null;
  bid_count: number | null;
  average_bid_minor: string | null;
}

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function toScorable(row: JobRow): ScorableJob {
  return {
    title: row.title,
    description: row.description,
    budgetMinMinor: num(row.budget_min_minor),
    budgetMaxMinor: num(row.budget_max_minor),
    currency: row.currency?.trim() ?? null,
    hourly: row.hourly,
    skills: row.skills,
    clientCountry: row.client_country?.trim() ?? null,
    clientPaymentVerified: row.client_payment_verified,
    clientSpendMinor: num(row.client_spend_minor),
    clientRating: num(row.client_rating),
    bidCount: row.bid_count,
    averageBidMinor: num(row.average_bid_minor),
  };
}

/** `job_scores.cost_usd_minor` is cents. Rounded up, so a call that cost anything never reads as free. */
export function nanoUsdToCentsCeil(nano: number): number {
  return Math.ceil(nano / 10_000_000);
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

export async function scoreJob(deps: ScoreDeps, data: ScoreJobData): Promise<ScoreResult> {
  const { db } = deps;
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<JobRow>(
    `select id, org_id, title, description, budget_min_minor::text, budget_max_minor::text,
            currency, hourly, skills, client_country, client_payment_verified,
            client_spend_minor::text, client_rating::text, bid_count, average_bid_minor::text
     from jobs where id = $1`,
    [data.jobId],
  );
  const row = rows[0];
  if (!row) throw new UnrecoverableError(`job ${data.jobId} does not exist`);

  // Idempotent: a redelivered or re-enqueued job does not pay for a second opinion.
  const existing = await db.query<{ id: string }>(
    'select id from job_scores where job_id = $1 order by created_at limit 1',
    [row.id],
  );
  if (existing.rows[0]) return { status: 'already_scored', scoreId: existing.rows[0].id };

  const job = toScorable(row);
  const findings = detectRedFlags(job);

  let result;
  try {
    result = await completeJson<ModelScore>({
      transport: deps.transport,
      model: deps.model,
      schema: SCORE_SCHEMA,
      system: SCORE_SYSTEM_PROMPT,
      prompt: buildScorePrompt(job),
      thinking: true,
      retries: 1,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      await inTransaction(db, async () => {
        await recordLlmCall(db, {
          orgId: row.org_id,
          purpose: 'score',
          model: deps.model,
          subjectTable: 'jobs',
          subjectId: row.id,
          requestId,
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          costNanoUsd: error.costNanoUsd,
          attempts: error.attempts,
          outcome: 'invalid_output',
          problems: error.problems,
        });
        await recordEvent(db, {
          orgId: row.org_id,
          type: 'job.scored',
          subjectTable: 'jobs',
          subjectId: row.id,
          requestId,
          outcome: 'error',
          payload: { reason: 'invalid_output', attempts: error.attempts, problems: error.problems },
        });
      });
      throw new UnrecoverableError(`job ${row.id}: ${error.message}`);
    }
    await recordEvent(db, {
      orgId: row.org_id,
      type: 'job.scored',
      subjectTable: 'jobs',
      subjectId: row.id,
      requestId,
      outcome: 'error',
      payload: { reason: 'transport', message: (error as Error).message },
    });
    throw error;
  }

  const score = reconcileScore(result.value, findings);

  const scoreId = await inTransaction(db, async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into job_scores
         (org_id, job_id, score, verdict, reasons, flags, reply_probability, model,
          input_tokens, output_tokens, cost_usd_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        row.org_id,
        row.id,
        score.score,
        score.verdict,
        score.reasons,
        score.flags,
        score.reply_probability,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        nanoUsdToCentsCeil(result.costNanoUsd),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`job ${row.id}: the score was not stored`);

    await recordLlmCall(db, {
      orgId: row.org_id,
      purpose: 'score',
      model: result.model,
      subjectTable: 'job_scores',
      subjectId: id,
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
    await recordEvent(db, {
      orgId: row.org_id,
      type: 'job.scored',
      subjectTable: 'job_scores',
      subjectId: id,
      requestId,
      outcome: 'ok',
      payload: {
        jobId: row.id,
        score: score.score,
        verdict: score.verdict,
        flags: score.flags,
        ruleOnlyFlags: score.ruleOnlyFlags,
      },
    });
    return id;
  });

  return { status: 'scored', scoreId, score };
}

export function createScoreProcessor(deps: ScoreDeps) {
  return (job: Job<ScoreJobData>): Promise<ScoreResult> => scoreJob(deps, job.data);
}

/** One score job per `jobs` row: BullMQ drops an add whose id is already queued. */
export function enqueueScore(queue: Queue, data: ScoreJobData) {
  return queue.add('score', data, { jobId: `score__${data.jobId}` });
}
