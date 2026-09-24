import {
  DRAFT_SYSTEM_PROMPT,
  buildDraftPrompt,
  buildDraftSchema,
  proposalBody,
  splitMilestones,
  type DraftPortfolioItem,
  type ModelDraft,
  type ScorableJob,
  readOnlyPlatformReason,
} from '@arbitron/core';
import {
  inTransaction,
  recordEvent,
  recordLlmCall,
  releasePlanUsage,
  type Queryable,
} from '@arbitron/db';
import { LlmOutputError, completeJson, type LlmTransport } from '@arbitron/llm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { meter, type UsageAlert } from './usage-alert.js';

/**
 * The draft-bid worker (ARB-043, docs/01 section E): "Builds bid from template + job +
 * client history + portfolio + real estimate + milestone split; queues for approval".
 * Writes a `proposals` row in status `queued` and the `proposal_citations` behind it.
 *
 * The price is the margin evaluation's (D-029: the price the margin was judged at), the
 * timeline the estimate's when it has one, the milestones sum to the price to the cent,
 * and every citation is a foreign key to an item the owner recorded (D-10). The model
 * supplies the words. Without an approved template (D-07) there is no draft, and the
 * event says so.
 */
export interface DraftJobData {
  readonly jobId: string;
  /** The passed margin evaluation to price from. Omitted, the job's latest is used. */
  readonly marginEvaluationId?: string;
  readonly requestId?: string;
}

export interface DraftDeps {
  /** A service-role connection: the worker acts for whichever org owns the job. */
  readonly db: Queryable;
  readonly transport: LlmTransport;
  readonly model: string;
  /** ARB-410: the 80 % and 100 % alerts (`createUsageAlert`). */
  readonly usageAlert?: ((alert: UsageAlert) => Promise<unknown>) | null;
}

export type DraftResult =
  | { readonly status: 'drafted'; readonly proposalId: string }
  | { readonly status: 'already_drafted'; readonly proposalId: string }
  | {
      readonly status: 'blocked';
      /** `plan_limit`: the org's plan has no room for another draft this month (ARB-410). */
      readonly reason: 'no_template' | 'plan_limit';
      readonly detail: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'no_margin' | 'margin_failed' | 'read_only_platform';
    };

interface JobRow {
  platform: string;
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
  category_slug: string | null;
}

interface EvaluationRow {
  id: string;
  passed: boolean;
  currency: string;
  client_budget_minor: string;
  delivery_estimate_id: string | null;
}

interface VariantRow {
  id: string;
  template_name: string;
  body: string;
}

interface PortfolioRow {
  id: string;
  title: string;
  url: string | null;
  description: string | null;
  kind: DraftPortfolioItem['kind'];
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

/**
 * The template for the job's category, else a general one (no category), and of its
 * variants the one fewest bids have been written from, then by label: an even A/B split
 * (D-064). The owner reads each variant's reply rate on the templates page and switches
 * off the one that loses; nothing here picks a winner on a handful of sends. Only active
 * rows; a template or variant the owner switched off is not written from.
 */
async function pickVariant(db: Queryable, orgId: string, categorySlug: string | null) {
  const { rows } = await db.query<VariantRow>(
    `select v.id, t.name as template_name, v.body
     from template_variants v
     join templates t on t.id = v.template_id
     where t.org_id = $1 and t.active and v.active
       and (t.category_slug = $2 or t.category_slug is null)
     order by (t.category_slug is not null) desc,
              (select count(*) from proposals p where p.template_variant_id = v.id),
              v.label
     limit 1`,
    [orgId, categorySlug],
  );
  return rows[0] ?? null;
}

/** Items the owner recorded and allowed to be shown, the job's category first, at most six. */
async function offeredPortfolio(db: Queryable, orgId: string, categorySlug: string | null) {
  const { rows } = await db.query<PortfolioRow>(
    `select id, title, url, description, kind from portfolio_items
     where org_id = $1 and active and permission_to_show
       and (category_slug = $2 or category_slug is null or $2 is null)
     order by (category_slug = $2) desc, title
     limit 6`,
    [orgId, categorySlug],
  );
  return rows;
}

export async function draftBid(deps: DraftDeps, data: DraftJobData): Promise<DraftResult> {
  const { db } = deps;
  const requestId = data.requestId ?? null;

  const jobs = await db.query<JobRow>(
    `select id, org_id, title, description, budget_min_minor::text, budget_max_minor::text,
            currency, hourly, skills, client_country, client_payment_verified,
            client_spend_minor::text, client_rating::text, bid_count, average_bid_minor::text,
            category_slug, platform::text as platform
     from jobs where id = $1`,
    [data.jobId],
  );
  const job = jobs.rows[0];
  if (!job) throw new UnrecoverableError(`job ${data.jobId} does not exist`);

  const note = async (outcome: 'blocked' | 'skipped', payload: Record<string, unknown>) => {
    await recordEvent(db, {
      orgId: job.org_id,
      type: 'proposal.drafted',
      subjectTable: 'jobs',
      subjectId: job.id,
      requestId,
      outcome,
      payload: { jobId: job.id, ...payload },
    });
  };

  // Upwork and Fiverr are read only here (docs/01 section B, D-066): no bid is drafted.
  const readOnly = readOnlyPlatformReason(job.platform);
  if (readOnly) {
    await note('skipped', {
      reason: 'read_only_platform',
      platform: job.platform,
      detail: readOnly,
    });
    return { status: 'skipped', reason: 'read_only_platform' };
  }

  const evaluations = await db.query<EvaluationRow>(
    data.marginEvaluationId
      ? `select id, passed, currency, client_budget_minor::text, delivery_estimate_id
         from margin_evaluations where job_id = $1 and id = $2`
      : `select id, passed, currency, client_budget_minor::text, delivery_estimate_id
         from margin_evaluations where job_id = $1 order by created_at desc limit 1`,
    data.marginEvaluationId ? [job.id, data.marginEvaluationId] : [job.id],
  );
  const evaluation = evaluations.rows[0];
  if (!evaluation) {
    await note('skipped', { reason: 'no_margin' });
    return { status: 'skipped', reason: 'no_margin' };
  }
  if (!evaluation.passed) {
    await note('skipped', { reason: 'margin_failed', marginEvaluationId: evaluation.id });
    return { status: 'skipped', reason: 'margin_failed' };
  }

  // Idempotent per evaluation: a redelivery keeps the draft; a rejected draft may be redone.
  const existing = await db.query<{ id: string }>(
    `select id from proposals
     where margin_evaluation_id = $1 and status <> 'rejected' order by created_at limit 1`,
    [evaluation.id],
  );
  if (existing.rows[0]) return { status: 'already_drafted', proposalId: existing.rows[0].id };

  const variant = await pickVariant(db, job.org_id, job.category_slug);
  if (!variant) {
    const detail = `no active bid template for ${job.category_slug ?? 'this job'} and no general one (docs/02 D-07)`;
    await note('blocked', { reason: 'no_template', detail, marginEvaluationId: evaluation.id });
    return { status: 'blocked', reason: 'no_template', detail };
  }

  // A draft is a model call, so it is metered (ARB-410), once the job is known to need
  // one and a template exists to write it from.
  const metered = await meter(deps, { orgId: job.org_id, metric: 'bids_drafted', requestId });
  if (!metered.ok) {
    await note('blocked', {
      reason: 'plan_limit',
      plan: metered.reason,
      detail: metered.message,
      marginEvaluationId: evaluation.id,
    });
    return { status: 'blocked', reason: 'plan_limit', detail: metered.message };
  }

  const estimate = evaluation.delivery_estimate_id
    ? await db.query<{ turnaround_days: number | null }>(
        'select turnaround_days from delivery_estimates where id = $1',
        [evaluation.delivery_estimate_id],
      )
    : null;
  const estimatedDays = estimate?.rows[0]?.turnaround_days ?? null;

  const portfolio = await offeredPortfolio(db, job.org_id, job.category_slug);
  const priceMinor = Number(evaluation.client_budget_minor);

  let result;
  try {
    result = await completeJson<ModelDraft>({
      transport: deps.transport,
      model: deps.model,
      schema: buildDraftSchema(portfolio.map((item) => item.id)),
      system: DRAFT_SYSTEM_PROMPT,
      prompt: buildDraftPrompt({
        job: toScorable(job),
        template: { name: variant.template_name, body: variant.body },
        priceMinor,
        currency: evaluation.currency,
        deliveryDays: estimatedDays,
        portfolio,
      }),
      thinking: true,
      maxTokens: 4_000,
      retries: 1,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      await inTransaction(db, async (tx) => {
        await recordLlmCall(tx, {
          orgId: job.org_id,
          purpose: 'draft',
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
        await recordEvent(tx, {
          orgId: job.org_id,
          type: 'proposal.drafted',
          subjectTable: 'jobs',
          subjectId: job.id,
          requestId,
          outcome: 'error',
          payload: { reason: 'invalid_output', attempts: error.attempts, problems: error.problems },
        });
      });
      throw new UnrecoverableError(`job ${job.id}: ${error.message}`);
    }
    // The model was never reached, so the draft is given back for the queue's retry.
    await releasePlanUsage(db, { orgId: job.org_id, metric: 'bids_drafted' });
    await recordEvent(db, {
      orgId: job.org_id,
      type: 'proposal.drafted',
      subjectTable: 'jobs',
      subjectId: job.id,
      requestId,
      outcome: 'error',
      payload: { reason: 'transport', message: (error as Error).message },
    });
    throw error;
  }

  const draft = result.value;
  // The schema already limited the ids to the offered ones; this keeps the rows in hand.
  const citations = portfolio.filter((item) => draft.portfolio_item_ids.includes(item.id));
  const milestones = splitMilestones(priceMinor, draft.milestones);
  const deliveryDays = estimatedDays ?? draft.delivery_days;
  const timelineSource = estimatedDays === null ? 'proposed_by_model' : 'estimate';

  const proposalId = await inTransaction(db, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into proposals
         (org_id, job_id, margin_evaluation_id, template_variant_id, body, amount_minor,
          currency, delivery_days, milestones, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued')
       returning id`,
      [
        job.org_id,
        job.id,
        evaluation.id,
        variant.id,
        proposalBody(draft.body, citations),
        priceMinor,
        evaluation.currency,
        deliveryDays,
        JSON.stringify(milestones),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`job ${job.id}: the proposal was not stored`);

    for (const item of citations) {
      await tx.query(
        'insert into proposal_citations (org_id, proposal_id, portfolio_item_id) values ($1, $2, $3)',
        [job.org_id, id, item.id],
      );
    }

    await recordLlmCall(tx, {
      orgId: job.org_id,
      purpose: 'draft',
      model: result.model,
      subjectTable: 'proposals',
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
    await recordEvent(tx, {
      orgId: job.org_id,
      type: 'proposal.drafted',
      subjectTable: 'proposals',
      subjectId: id,
      requestId,
      outcome: 'ok',
      payload: {
        jobId: job.id,
        marginEvaluationId: evaluation.id,
        templateVariantId: variant.id,
        amountMinor: priceMinor,
        currency: evaluation.currency,
        deliveryDays,
        timelineSource,
        milestones,
        citations: citations.map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
        operatorNotes: draft.operator_notes,
      },
    });
    return id;
  });

  return { status: 'drafted', proposalId };
}

export function createDraftProcessor(deps: DraftDeps) {
  return (job: Job<DraftJobData>): Promise<DraftResult> => draftBid(deps, job.data);
}

/** One draft per margin evaluation: BullMQ drops an add whose id is already queued. */
export function enqueueDraft(queue: Queue, data: DraftJobData) {
  return queue.add('draft-bid', data, {
    jobId: `draft__${data.marginEvaluationId ?? data.jobId}`,
  });
}
