import { convertMinor, feeOn, findFeeRule, parseFeeTable, type FeeRule } from '@arbitron/core';
import { recordEvent, type Queryable } from '@arbitron/db';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import {
  evaluateJobMargin,
  type FxRateSource,
  type MarginBlockReason,
  type MarginResult,
} from './margin.js';

/**
 * The reprice worker (ARB-204, docs/01 section E: "reprice — candidate quote received —
 * recomputes estimate and margin with the real quote"). A candidate's quote becomes a
 * delivery estimate with method `candidate_quote`, and the margin engine (ARB-041, D-029)
 * judges it exactly as it judges any estimate: same rules, same blocks while a rule is
 * missing, never a default. The change is one `margin.repriced` event with the margin
 * before and after, and an alert goes to the operator when the new margin fails the rule.
 *
 * A bid on our own Freelancer.com project costs its quote plus the employer's project fee
 * (docs/02 T-02 names the fee "for employers (when we post sourcing projects)"), taken
 * from the org's fee table like every other fee: without that rule nothing is priced.
 */
export interface RepriceJobData {
  readonly candidateId: string;
  readonly requestId?: string;
}

/** What the operator is told about when a real quote breaks the margin rule. */
export interface RepriceAlert {
  readonly orgId: string;
  readonly candidateId: string;
  readonly evaluationId: string;
}

export interface RepriceDeps {
  readonly db: Queryable;
  readonly fx?: FxRateSource | null;
  /** The Telegram card for a breach (apps/telegram, `repriceAlert`). Optional: absent, the event still records it. */
  readonly alert?: (alert: RepriceAlert) => Promise<unknown>;
}

export type RepriceResult =
  | {
      readonly status: 'repriced';
      readonly estimateId: string;
      readonly evaluationId: string;
      readonly passed: boolean;
      readonly alerted: boolean;
    }
  | {
      readonly status: 'blocked';
      /** Null when the cost itself could not be worked out (the employer fee's rule). */
      readonly estimateId: string | null;
      readonly reason: string;
      readonly detail: string[];
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'no_quote' | 'no_job' | 'no_budget' | 'unchanged';
      readonly message: string;
    };

interface CandidateRow {
  id: string;
  org_id: string;
  sourcing_request_id: string;
  supplier_id: string | null;
  display_name: string;
  quoted_price_minor: string | null;
  currency: string | null;
  turnaround_days: number | null;
  external_bid_id: string | null;
  brief_id: string;
  category_slug: string | null;
  job_id: string | null;
}

interface EvaluationRow {
  id: string;
  margin_minor: string;
  margin_pct: string;
  passed: boolean;
  currency: string;
}

const latestEvaluation = async (db: Queryable, jobId: string, exceptEstimate?: string) =>
  (
    await db.query<EvaluationRow>(
      `select id, margin_minor::text, margin_pct::text, passed, currency::text as currency
         from margin_evaluations
        where job_id = $1 and ($2::uuid is null or delivery_estimate_id is distinct from $2::uuid)
        order by created_at desc limit 1`,
      [jobId, exceptEstimate ?? null],
    )
  ).rows[0] ?? null;

const describe = (row: EvaluationRow | null) =>
  row
    ? {
        evaluation_id: row.id,
        margin_minor: row.margin_minor,
        margin_pct: row.margin_pct,
        passed: row.passed,
        currency: row.currency.trim(),
      }
    : null;

type EmployerFee =
  | {
      readonly ok: true;
      readonly feeMinor: number;
      readonly minimumApplied: boolean;
      readonly rule: FeeRule;
    }
  | { readonly ok: false; readonly reason: MarginBlockReason; readonly detail: string[] };

/** The employer's fee on a bid for a fixed-price project we posted (ARB-203 posts fixed ones). */
async function employerFee(
  db: Queryable,
  orgId: string,
  quoteMinor: number,
  currency: string,
  fx: FxRateSource | null | undefined,
): Promise<EmployerFee> {
  const settings = await db.query<{ fee_table: unknown }>(
    'select fee_table from settings where org_id = $1',
    [orgId],
  );
  const raw = settings.rows[0]?.fee_table;
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, reason: 'rules_missing', detail: ['fee_table (docs/02 T-02)'] };
  const table = parseFeeTable(raw);
  if (!table.ok)
    return {
      ok: false,
      reason: 'fee_table_invalid',
      detail: table.errors.map((error) => `fee_table${error.field} ${error.message}`),
    };
  const rule = findFeeRule(table.value, 'freelancer', 'fixed', 'employer');
  if (!rule)
    return {
      ok: false,
      reason: 'fee_rule_missing',
      detail: [
        'no fee rule for freelancer fixed projects on the employer side, which a bid on our own project pays (docs/02 T-02)',
      ],
    };
  let minimumMinor: number | null = null;
  if (rule.minMinor !== null && rule.minCurrency !== null) {
    if (rule.minCurrency === currency) minimumMinor = rule.minMinor;
    else if (!fx)
      return {
        ok: false,
        reason: 'fx_unavailable',
        detail: [
          `the employer fee minimum is in ${rule.minCurrency} and no FX provider is configured to convert it to ${currency} (docs/02 B-10)`,
        ],
      };
    else minimumMinor = convertMinor(rule.minMinor, await fx.quote(rule.minCurrency, currency));
  }
  return { ok: true, ...feeOn(quoteMinor, rule, minimumMinor), rule };
}

export async function repriceCandidate(
  deps: RepriceDeps,
  data: RepriceJobData,
): Promise<RepriceResult> {
  const { db } = deps;
  const requestId = data.requestId ?? null;
  const { rows } = await db.query<CandidateRow>(
    `select c.id, c.org_id, c.sourcing_request_id, c.supplier_id, c.display_name,
            c.quoted_price_minor::text as quoted_price_minor, c.currency::text as currency, c.turnaround_days,
            c.external_bid_id, r.brief_id, b.category_slug, t.job_id
       from supplier_candidates c
       join sourcing_requests r on r.id = c.sourcing_request_id
       join briefs b on b.id = r.brief_id
       join threads t on t.id = b.thread_id
      where c.id = $1`,
    [data.candidateId],
  );
  const candidate = rows[0];
  if (!candidate) throw new UnrecoverableError(`candidate ${data.candidateId} does not exist`);
  const currency = candidate.currency?.trim() ?? null;

  const note = (outcome: 'ok' | 'blocked' | 'skipped', payload: Record<string, unknown>) =>
    recordEvent(db, {
      orgId: candidate.org_id,
      type: 'margin.repriced',
      actorKind: 'system',
      subjectTable: 'supplier_candidates',
      subjectId: candidate.id,
      requestId,
      outcome,
      payload: {
        candidate: candidate.display_name,
        sourcing_request_id: candidate.sourcing_request_id,
        ...payload,
      },
    });

  if (candidate.quoted_price_minor === null || currency === null) {
    const message = 'This candidate has no quote yet, so there is nothing to reprice with.';
    await note('skipped', { reason: 'no_quote', message });
    return { status: 'skipped', reason: 'no_quote', message };
  }
  if (!candidate.job_id) {
    const message =
      'The conversation behind this brief has no job, so there is no bid margin to reprice.';
    await note('skipped', { reason: 'no_job', message });
    return { status: 'skipped', reason: 'no_job', message };
  }

  const quoteMinor = Number(candidate.quoted_price_minor);
  let costMinor = quoteMinor;
  let feeLine: Record<string, unknown> | null = null;
  if (candidate.external_bid_id !== null) {
    const fee = await employerFee(db, candidate.org_id, quoteMinor, currency, deps.fx);
    if (!fee.ok) {
      await note('blocked', { reason: fee.reason, detail: fee.detail, estimate_id: null });
      return { status: 'blocked', estimateId: null, reason: fee.reason, detail: fee.detail };
    }
    costMinor = quoteMinor + fee.feeMinor;
    feeLine = {
      employer_fee_minor: fee.feeMinor,
      minimum_applied: fee.minimumApplied,
      percent: fee.rule.percent,
      source_url: fee.rule.sourceUrl,
      read_on: fee.rule.readOn,
    };
  }
  const cost = String(costMinor);

  // One estimate per candidate and cost: a redelivered job, or a bid read again at the
  // same price, changes nothing.
  const existing = await db.query<{ id: string; expected_minor: string }>(
    `select id, expected_minor::text from delivery_estimates
      where supplier_candidate_id = $1 order by created_at desc limit 1`,
    [candidate.id],
  );
  const before = await latestEvaluation(db, candidate.job_id);
  let estimateId: string;
  if (existing.rows[0] && existing.rows[0].expected_minor === cost) {
    estimateId = existing.rows[0].id;
    const judged = await db.query(
      'select 1 from margin_evaluations where delivery_estimate_id = $1',
      [estimateId],
    );
    if (judged.rows.length > 0) {
      const message = 'The quote has not changed since it was last priced.';
      await note('skipped', { reason: 'unchanged', message });
      return { status: 'skipped', reason: 'unchanged', message };
    }
  } else {
    const inserted = await db.query<{ id: string }>(
      `insert into delivery_estimates (org_id, job_id, brief_id, category_slug, method, currency,
                                       low_minor, expected_minor, high_minor, turnaround_days,
                                       supplier_id, supplier_candidate_id)
       values ($1, $2, $3, $4, 'candidate_quote', $5, $6, $6, $6, $7, $8, $9) returning id`,
      [
        candidate.org_id,
        candidate.job_id,
        candidate.brief_id,
        candidate.category_slug,
        currency,
        cost,
        candidate.turnaround_days,
        candidate.supplier_id,
        candidate.id,
      ],
    );
    estimateId = inserted.rows[0]!.id;
  }

  const margin: MarginResult = await evaluateJobMargin(
    { db, ...(deps.fx !== undefined ? { fx: deps.fx } : {}) },
    { jobId: candidate.job_id, estimateId, ...(requestId ? { requestId } : {}) },
  );
  if (margin.status === 'skipped') {
    const message =
      margin.reason === 'no_budget'
        ? 'The job states no budget, so no margin can be worked out.'
        : 'There is no estimate to judge.';
    await note('skipped', { reason: margin.reason, message, estimate_id: estimateId });
    return { status: 'skipped', reason: 'no_budget', message };
  }
  if (margin.status === 'blocked') {
    await note('blocked', {
      reason: margin.reason,
      detail: margin.detail,
      estimate_id: estimateId,
      before: describe(before),
    });
    return { status: 'blocked', estimateId, reason: margin.reason, detail: margin.detail };
  }
  const after = await latestEvaluation(db, candidate.job_id);
  const evaluationId = margin.evaluationId;
  const passed = margin.status === 'evaluated' ? margin.passed : (after?.passed ?? false);
  await note('ok', {
    estimate_id: estimateId,
    quote_minor: candidate.quoted_price_minor,
    cost_minor: cost,
    ...(feeLine ? { employer_fee: feeLine } : {}),
    currency,
    before: describe(before),
    after: describe(after),
  });
  let alerted = false;
  if (!passed && deps.alert) {
    await deps.alert({ orgId: candidate.org_id, candidateId: candidate.id, evaluationId });
    alerted = true;
  }
  return { status: 'repriced', estimateId, evaluationId, passed, alerted };
}

export function createRepriceProcessor(deps: RepriceDeps) {
  return (job: Job<RepriceJobData>): Promise<RepriceResult> => repriceCandidate(deps, job.data);
}

/** One reprice per candidate and quote: a changed quote is a new job id. */
export function enqueueReprice(
  queue: Queue,
  data: RepriceJobData & { readonly quoteMinor?: string },
) {
  const { quoteMinor, ...rest } = data;
  return queue.add('reprice', rest, {
    jobId: `reprice__${data.candidateId}__${quoteMinor ?? 'now'}`,
  });
}
