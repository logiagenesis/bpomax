import {
  HOME_CURRENCY,
  convertMinor,
  evaluateMargin,
  findFeeRule,
  parseFeeTable,
  type FxQuote,
  type MarginEvaluation,
  type Platform,
  readOnlyPlatformReason,
} from '@arbitron/core';
import { inTransaction, recordEvent, type Queryable } from '@arbitron/db';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { enqueueDraft } from './draft-bid.js';

/**
 * The margin worker (ARB-041, docs/01 section E): "margin = client budget − platform fee −
 * supplier cost − FX buffer − tool costs; compares to org rules". Writes
 * `margin_evaluations`, one per delivery estimate, with every input line.
 *
 * The rules are the org's settings. While any of them is missing (docs/02 D-02, D-03,
 * T-02) the worker records that it is blocked and by what; it never fills the gap with a
 * default. A deal not in ZAR needs a rate to ZAR from the FX provider (docs/02 B-10), and
 * the rate and its time are stored with the evaluation (05 section 3.4).
 */
export interface FxRateSource {
  /** Units of `to` per one unit of `from`, observed now. Throws when it cannot say. */
  quote(from: string, to: string): Promise<FxQuote>;
}

export interface MarginJobData {
  readonly jobId: string;
  /** The estimate to judge. Omitted, the job's latest estimate is used. */
  readonly estimateId?: string;
  readonly requestId?: string;
}

export interface MarginDeps {
  /** A service-role connection: the worker acts for whichever org owns the job. */
  readonly db: Queryable;
  /** Absent until B-10 is answered. Only needed for deals not in ZAR. */
  readonly fx?: FxRateSource | null;
  /** Where a passed evaluation goes next: "draft-bid — trigger: margin passed" (01 section E). */
  readonly draftQueue?: Queue;
}

export type MarginBlockReason =
  | 'rules_missing'
  | 'fee_table_invalid'
  | 'fee_rule_missing'
  | 'fx_unavailable'
  | 'currency_mismatch';

export type MarginResult =
  | { readonly status: 'evaluated'; readonly evaluationId: string; readonly passed: boolean }
  | { readonly status: 'already_evaluated'; readonly evaluationId: string }
  | { readonly status: 'blocked'; readonly reason: MarginBlockReason; readonly detail: string[] }
  | { readonly status: 'skipped'; readonly reason: 'no_estimate' | 'no_budget' };

interface JobRow {
  id: string;
  org_id: string;
  platform: Platform;
  currency: string | null;
  hourly: boolean;
  budget_min_minor: string | null;
  budget_max_minor: string | null;
}

interface EstimateRow {
  id: string;
  method: string;
  currency: string;
  expected_minor: string;
}

interface SettingsRow {
  min_margin_pct: string | null;
  min_margin_zar_minor: string | null;
  fx_buffer_pct: string | null;
  fee_table: unknown;
}

async function note(
  db: Queryable,
  job: JobRow,
  requestId: string | null,
  outcome: 'blocked' | 'skipped',
  payload: Record<string, unknown>,
): Promise<void> {
  await recordEvent(db, {
    orgId: job.org_id,
    type: 'margin.evaluated',
    subjectTable: 'jobs',
    subjectId: job.id,
    requestId,
    outcome,
    payload: { jobId: job.id, ...payload },
  });
}

export async function evaluateJobMargin(
  deps: MarginDeps,
  data: MarginJobData,
): Promise<MarginResult> {
  const { db } = deps;
  const requestId = data.requestId ?? null;

  const jobs = await db.query<JobRow>(
    `select id, org_id, platform, currency, hourly, budget_min_minor::text, budget_max_minor::text
     from jobs where id = $1`,
    [data.jobId],
  );
  const job = jobs.rows[0];
  if (!job) throw new UnrecoverableError(`job ${data.jobId} does not exist`);

  const estimates = await db.query<EstimateRow>(
    data.estimateId
      ? `select id, method, currency, expected_minor::text from delivery_estimates
         where job_id = $1 and id = $2`
      : `select id, method, currency, expected_minor::text from delivery_estimates
         where job_id = $1 order by created_at desc limit 1`,
    data.estimateId ? [job.id, data.estimateId] : [job.id],
  );
  const estimate = estimates.rows[0];
  if (!estimate) {
    await note(db, job, requestId, 'skipped', { reason: 'no_estimate' });
    return { status: 'skipped', reason: 'no_estimate' };
  }

  // Idempotent per estimate: a redelivered job keeps its evaluation; a new estimate (the
  // reprice worker's) gets a new one.
  const existing = await db.query<{ id: string }>(
    'select id from margin_evaluations where delivery_estimate_id = $1 order by created_at limit 1',
    [estimate.id],
  );
  if (existing.rows[0]) return { status: 'already_evaluated', evaluationId: existing.rows[0].id };

  // The client's ceiling is what the bid is priced against: a deal that cannot clear
  // there cannot clear at all, and one that does leaves the draft-bid worker room below it.
  const budgetText = job.budget_max_minor ?? job.budget_min_minor;
  const currency = job.currency?.trim() ?? '';
  if (budgetText === null || !currency) {
    await note(db, job, requestId, 'skipped', { reason: 'no_budget' });
    return { status: 'skipped', reason: 'no_budget' };
  }
  const clientBudgetMinor = Number(budgetText);

  const blocked = async (reason: MarginBlockReason, detail: string[]): Promise<MarginResult> => {
    await note(db, job, requestId, 'blocked', { reason, detail, estimateId: estimate.id });
    return { status: 'blocked', reason, detail };
  };

  if (estimate.currency.trim() !== currency) {
    return blocked('currency_mismatch', [
      `the estimate is in ${estimate.currency.trim()} but the job is in ${currency}`,
    ]);
  }

  const settings = await db.query<SettingsRow>(
    `select min_margin_pct::text, min_margin_zar_minor::text, fx_buffer_pct::text, fee_table
     from settings where org_id = $1`,
    [job.org_id],
  );
  const rules = settings.rows[0] ?? {
    min_margin_pct: null,
    min_margin_zar_minor: null,
    fx_buffer_pct: null,
    fee_table: [],
  };
  const missing: string[] = [];
  if (rules.min_margin_pct === null) missing.push('min_margin_pct (docs/02 D-02)');
  if (rules.min_margin_zar_minor === null) missing.push('min_margin_zar_minor (docs/02 D-02)');
  if (rules.fx_buffer_pct === null) missing.push('fx_buffer_pct (docs/02 D-03)');
  if (!Array.isArray(rules.fee_table) || rules.fee_table.length === 0) {
    missing.push('fee_table (docs/02 T-02)');
  }
  if (missing.length > 0) return blocked('rules_missing', missing);

  const feeTable = parseFeeTable(rules.fee_table);
  if (!feeTable.ok) {
    return blocked(
      'fee_table_invalid',
      feeTable.errors.map((error) => `fee_table${error.field} ${error.message}`),
    );
  }
  const projectType = job.hourly ? 'hourly' : 'fixed';
  const fee = findFeeRule(feeTable.value, job.platform, projectType, 'freelancer');
  if (!fee) {
    return blocked('fee_rule_missing', [
      `no fee rule for ${job.platform} ${projectType} projects on the freelancer side (docs/02 T-02)`,
    ]);
  }

  // Rates: the deal to ZAR when the deal is not in ZAR, and the fee minimum to the deal
  // currency when it is quoted in another. Each is asked of the provider once.
  const quotes = new Map<string, FxQuote>();
  const quote = async (from: string, to: string): Promise<FxQuote | null> => {
    if (from === to) return null;
    const key = `${from}/${to}`;
    const known = quotes.get(key);
    if (known) return known;
    if (!deps.fx) return null;
    const fresh = await deps.fx.quote(from, to);
    quotes.set(key, fresh);
    return fresh;
  };
  let fxToHome: FxQuote | null = null;
  let feeMinimumMinor: number | null = null;
  try {
    if (currency !== HOME_CURRENCY) {
      fxToHome = await quote(currency, HOME_CURRENCY);
      if (!fxToHome) {
        return blocked('fx_unavailable', [
          `a ${currency} deal needs a ${currency}→${HOME_CURRENCY} rate and no FX provider is configured (docs/02 B-10)`,
        ]);
      }
    }
    if (fee.minMinor !== null && fee.minCurrency !== null) {
      if (fee.minCurrency === currency) {
        feeMinimumMinor = fee.minMinor;
      } else {
        const toDeal = await quote(fee.minCurrency, currency);
        if (!toDeal) {
          return blocked('fx_unavailable', [
            `the fee minimum is in ${fee.minCurrency} and no FX provider is configured to convert it to ${currency} (docs/02 B-10)`,
          ]);
        }
        feeMinimumMinor = convertMinor(fee.minMinor, toDeal);
      }
    }
  } catch (error) {
    // The provider exists but did not answer: nothing was judged, so the queue retries.
    await recordEvent(db, {
      orgId: job.org_id,
      type: 'margin.evaluated',
      subjectTable: 'jobs',
      subjectId: job.id,
      requestId,
      outcome: 'error',
      payload: { jobId: job.id, reason: 'fx_provider', message: (error as Error).message },
    });
    throw error;
  }

  const evaluation: MarginEvaluation = evaluateMargin({
    currency,
    hourly: job.hourly,
    clientBudgetMinor,
    supplierCostMinor: Number(estimate.expected_minor),
    toolCostMinor: 0,
    fee,
    feeMinimumMinor,
    fxBufferPercent: Number(rules.fx_buffer_pct),
    minMarginPercent: Number(rules.min_margin_pct),
    minMarginHomeMinor: Number(rules.min_margin_zar_minor),
    fxToHome,
  });

  const evaluationId = await inTransaction(db, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into margin_evaluations
         (org_id, job_id, delivery_estimate_id, currency, client_budget_minor,
          platform_fee_minor, supplier_cost_minor, fx_buffer_minor, tool_cost_minor,
          margin_minor, margin_pct, min_margin_pct, min_margin_zar_minor,
          fx_rate_used, fx_rate_at, passed, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning id`,
      [
        job.org_id,
        job.id,
        estimate.id,
        evaluation.currency,
        evaluation.clientBudgetMinor,
        evaluation.platformFeeMinor,
        evaluation.supplierCostMinor,
        evaluation.fxBufferMinor,
        evaluation.toolCostMinor,
        evaluation.marginMinor,
        evaluation.marginPercent,
        rules.min_margin_pct,
        rules.min_margin_zar_minor,
        fxToHome?.rate ?? null,
        fxToHome?.at ?? null,
        evaluation.passed,
        evaluation.reason,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`job ${job.id}: the margin evaluation was not stored`);
    await recordEvent(tx, {
      orgId: job.org_id,
      type: 'margin.evaluated',
      subjectTable: 'margin_evaluations',
      subjectId: id,
      requestId,
      outcome: 'ok',
      payload: {
        jobId: job.id,
        estimateId: estimate.id,
        estimateMethod: estimate.method,
        hourly: job.hourly,
        ...evaluation,
        feeRule: {
          percent: fee.percent,
          minMinor: fee.minMinor,
          minCurrency: fee.minCurrency,
          sourceUrl: fee.sourceUrl,
          readOn: fee.readOn,
        },
        fx: fxToHome ? { rate: fxToHome.rate, at: fxToHome.at, source: fxToHome.source } : null,
      },
    });
    return id;
  });

  // Only a committed, passed evaluation is drafted from.
  // Upwork and Fiverr are read only here (D-066): a passed margin there is not drafted from.
  if (deps.draftQueue && evaluation.passed && !readOnlyPlatformReason(job.platform)) {
    await enqueueDraft(deps.draftQueue, {
      jobId: job.id,
      marginEvaluationId: evaluationId,
      ...(requestId ? { requestId } : {}),
    });
  }

  return { status: 'evaluated', evaluationId, passed: evaluation.passed };
}

export function createMarginProcessor(deps: MarginDeps) {
  return (job: Job<MarginJobData>): Promise<MarginResult> => evaluateJobMargin(deps, job.data);
}

/** One margin job per estimate: BullMQ drops an add whose id is already queued. */
export function enqueueMargin(queue: Queue, data: MarginJobData) {
  return queue.add('margin', data, { jobId: `margin__${data.estimateId ?? data.jobId}` });
}
