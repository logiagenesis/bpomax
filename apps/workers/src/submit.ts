import {
  bidPayload,
  checkApproval,
  liveGate,
  type BidPayload,
  type Platform,
} from '@arbitron/core';
import {
  recordEvent,
  releaseBid,
  releaseScannerSlot,
  reserveBid,
  reserveScannerSlot,
  type Queryable,
} from '@arbitron/db';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';

/**
 * The submit worker (ARB-044, docs/01 sections E and H): "Places bid via API; creates
 * pipeline item; enforces daily cap and LIVE_MODE". Reads an approved proposal and, in
 * order: the approval record, the scanner's daily cap and score floor for an auto
 * approval, the live gate, the account's bid allowance, and only then the platform.
 *
 * The platform call is an adapter (`BidPlacer`) the worker is given. None exists until
 * the Freelancer client lands (ARB-020, docs/BLOCKERS.md C-02); without one, a live
 * submission is recorded as blocked and nothing is sent. With LIVE_MODE off, nothing is
 * sent either, and the bid that would have been sent is written to the audit log.
 */
export interface BidPlacer {
  /** Places the bid on the platform and returns its reference there. Throws when the platform refuses or cannot be reached. */
  placeBid(payload: BidPayload): Promise<{ platformRef: string }>;
}

export interface SubmitJobData {
  readonly proposalId: string;
  readonly requestId?: string;
}

export interface SubmitDeps {
  /** A service-role connection: the worker acts for whichever org owns the proposal. */
  readonly db: Queryable;
  /** LIVE_MODE from the environment. */
  readonly liveMode: boolean;
  /** The platform client. Absent until ARB-020. */
  readonly placer?: BidPlacer | null;
  /** Defaults to the current time; tests fix it. */
  readonly now?: () => Date;
}

export type SubmitBlockReason =
  | 'live_mode_off'
  | 'no_client'
  | 'allowance'
  | 'daily_cap_reached'
  | 'below_min_score'
  | 'auto_send_off'
  | 'no_scanner';

export type SubmitResult =
  | { readonly status: 'submitted'; readonly platformRef: string; readonly pipelineItemId: string }
  | { readonly status: 'already_submitted'; readonly platformRef: string | null }
  | { readonly status: 'skipped'; readonly reason: 'not_approved' | 'approval_incomplete' }
  | { readonly status: 'blocked'; readonly reason: SubmitBlockReason; readonly message: string }
  | { readonly status: 'failed'; readonly message: string };

interface ProposalRow {
  id: string;
  org_id: string;
  job_id: string;
  status: 'draft' | 'queued' | 'approved' | 'rejected' | 'submitted' | 'failed';
  approved_by: string | null;
  approved_via: 'telegram' | 'web' | 'auto' | null;
  body: string;
  amount_minor: string;
  currency: string;
  delivery_days: number;
  milestones: { title: string; amount_minor: number }[];
  platform_ref: string | null;
  platform: Platform;
  job_external_id: string;
  scanner_id: string | null;
}

interface ScannerRow {
  auto_send: boolean;
  min_score: number | null;
  daily_cap: number;
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

/** The bookkeeping of a placed bid: the proposal, its pipeline item, and the events, in one transaction. */
async function recordPlaced(
  db: Queryable,
  proposal: ProposalRow,
  platformRef: string,
  requestId: string | null,
  now: Date,
): Promise<string> {
  return inTransaction(db, async () => {
    await db.query(
      `update proposals set status = 'submitted', submitted_at = $2, platform_ref = $3 where id = $1`,
      [proposal.id, now.toISOString(), platformRef],
    );
    const item = await db.query<{ id: string }>(
      `insert into pipeline_items (org_id, job_id, proposal_id, stage, value_minor, currency)
       values ($1, $2, $3, 'applied', $4, $5)
       on conflict (job_id) do update
         set proposal_id = excluded.proposal_id, stage = 'applied', value_minor = excluded.value_minor,
             currency = excluded.currency, stage_changed_at = now()
       returning id`,
      [
        proposal.org_id,
        proposal.job_id,
        proposal.id,
        Number(proposal.amount_minor),
        proposal.currency,
      ],
    );
    const pipelineItemId = item.rows[0]?.id;
    if (!pipelineItemId)
      throw new Error(`proposal ${proposal.id}: the pipeline item was not stored`);
    await recordEvent(db, {
      orgId: proposal.org_id,
      type: 'proposal.submitted',
      subjectTable: 'proposals',
      subjectId: proposal.id,
      requestId,
      outcome: 'ok',
      payload: {
        jobId: proposal.job_id,
        platform: proposal.platform,
        platformRef,
        approvedVia: proposal.approved_via,
      },
    });
    await recordEvent(db, {
      orgId: proposal.org_id,
      type: 'pipeline.stage_changed',
      subjectTable: 'pipeline_items',
      subjectId: pipelineItemId,
      requestId,
      outcome: 'ok',
      payload: { jobId: proposal.job_id, proposalId: proposal.id, stage: 'applied' },
    });
    return pipelineItemId;
  });
}

export async function submitProposal(
  deps: SubmitDeps,
  data: SubmitJobData,
  options: { finalAttempt?: boolean } = {},
): Promise<SubmitResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<ProposalRow>(
    `select p.id, p.org_id, p.job_id, p.status, p.approved_by, p.approved_via, p.body,
            p.amount_minor::text, p.currency, p.delivery_days, p.milestones, p.platform_ref,
            j.platform, j.external_id as job_external_id, j.scanner_id
     from proposals p join jobs j on j.id = p.job_id
     where p.id = $1`,
    [data.proposalId],
  );
  const proposal = rows[0];
  if (!proposal) throw new UnrecoverableError(`proposal ${data.proposalId} does not exist`);

  const note = async (
    outcome: 'blocked' | 'skipped' | 'error',
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await recordEvent(db, {
      orgId: proposal.org_id,
      type: 'proposal.submitted',
      subjectTable: 'proposals',
      subjectId: proposal.id,
      requestId,
      outcome,
      payload: { jobId: proposal.job_id, ...payload },
    });
  };

  const approval = checkApproval({
    status: proposal.status,
    approvedBy: proposal.approved_by,
    approvedVia: proposal.approved_via,
  });
  if (!approval.ok) {
    if (approval.reason === 'already_submitted') {
      return { status: 'already_submitted', platformRef: proposal.platform_ref };
    }
    await note('skipped', { reason: approval.reason, status: proposal.status });
    return { status: 'skipped', reason: approval.reason };
  }

  const payload = bidPayload({
    platform: proposal.platform,
    jobExternalId: proposal.job_external_id,
    proposalId: proposal.id,
    amountMinor: Number(proposal.amount_minor),
    currency: proposal.currency,
    deliveryDays: proposal.delivery_days,
    milestones: proposal.milestones,
    body: proposal.body,
  });

  // A bid placed on an earlier attempt whose bookkeeping did not finish: finish it,
  // rather than place it twice.
  const placedBefore = await db.query<{ payload: { platformRef?: string } }>(
    `select payload from events
     where type = 'external.call' and subject_table = 'proposals' and subject_id = $1 and outcome = 'ok'
     order by created_at desc limit 1`,
    [proposal.id],
  );
  const earlierRef = placedBefore.rows[0]?.payload.platformRef;
  if (earlierRef) {
    const pipelineItemId = await recordPlaced(db, proposal, earlierRef, requestId, now);
    return { status: 'submitted', platformRef: earlierRef, pipelineItemId };
  }

  // An auto approval is held to its scanner's guardrails (01 section H) at the moment of
  // sending, whatever approved it: the cap, the score floor, and auto-send being on.
  let scannerSlotTaken = false;
  const giveBackSlot = async () => {
    if (scannerSlotTaken && proposal.scanner_id) {
      await releaseScannerSlot(db, { orgId: proposal.org_id, scannerId: proposal.scanner_id, now });
      scannerSlotTaken = false;
    }
  };
  const blocked = async (
    reason: SubmitBlockReason,
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    await giveBackSlot();
    await note('blocked', { reason, message, ...extra });
    return { status: 'blocked', reason, message } as const;
  };

  if (approval.via === 'auto') {
    if (!proposal.scanner_id) {
      return blocked(
        'no_scanner',
        'An automatic approval needs the scanner that found the job, and this job has none.',
      );
    }
    const scanners = await db.query<ScannerRow>(
      'select auto_send, min_score, daily_cap from scanners where id = $1',
      [proposal.scanner_id],
    );
    const scanner = scanners.rows[0];
    if (!scanner?.auto_send) {
      return blocked(
        'auto_send_off',
        'The scanner that found this job does not have auto-send switched on.',
      );
    }
    const scores = await db.query<{ score: number }>(
      'select score from job_scores where job_id = $1 order by created_at desc limit 1',
      [proposal.job_id],
    );
    const score = scores.rows[0]?.score ?? null;
    if (score === null || scanner.min_score === null || score < scanner.min_score) {
      return blocked(
        'below_min_score',
        `The job scored ${score === null ? 'nothing' : String(score)}, below the scanner's minimum of ${String(scanner.min_score ?? 'unset')} for auto-send.`,
      );
    }
    const slot = await reserveScannerSlot(db, {
      orgId: proposal.org_id,
      scannerId: proposal.scanner_id,
      dailyCap: scanner.daily_cap,
      now,
    });
    if (!slot.ok)
      return blocked('daily_cap_reached', slot.message, { used: slot.used, cap: slot.cap });
    scannerSlotTaken = true;
  }

  const settings = await db.query<{ live_mode: boolean }>(
    'select live_mode from settings where org_id = $1',
    [proposal.org_id],
  );
  const gate = liveGate({
    envLiveMode: deps.liveMode,
    orgLiveMode: settings.rows[0]?.live_mode ?? false,
  });
  if (!gate.live) {
    await giveBackSlot();
    await recordEvent(db, {
      orgId: proposal.org_id,
      type: 'external.blocked_by_live_mode',
      subjectTable: 'proposals',
      subjectId: proposal.id,
      requestId,
      outcome: 'blocked',
      payload: { closedBy: gate.closedBy, wouldSend: payload },
    });
    await note('blocked', {
      reason: 'live_mode_off',
      message: gate.message,
      closedBy: gate.closedBy,
    });
    return { status: 'blocked', reason: 'live_mode_off', message: gate.message };
  }

  const allowance = await reserveBid(db, {
    orgId: proposal.org_id,
    platform: proposal.platform,
    now,
  });
  if (!allowance.ok)
    return blocked('allowance', allowance.message, { allowance: allowance.reason });
  const giveBackBid = () =>
    releaseBid(db, { orgId: proposal.org_id, platform: proposal.platform, now });

  if (!deps.placer) {
    await giveBackBid();
    return blocked(
      'no_client',
      `Live mode is on but there is no ${proposal.platform} client to place the bid with yet (ARB-020, docs/BLOCKERS.md C-02). Nothing was sent.`,
    );
  }

  let platformRef: string;
  try {
    ({ platformRef } = await deps.placer.placeBid(payload));
  } catch (error) {
    const message = (error as Error).message;
    await giveBackBid();
    await giveBackSlot();
    await recordEvent(db, {
      orgId: proposal.org_id,
      type: 'external.call',
      subjectTable: 'proposals',
      subjectId: proposal.id,
      requestId,
      outcome: 'error',
      payload: {
        action: 'place_bid',
        platform: proposal.platform,
        message,
        finalAttempt: options.finalAttempt ?? false,
      },
    });
    if (!options.finalAttempt) throw error;
    await db.query(`update proposals set status = 'failed', failure_reason = $2 where id = $1`, [
      proposal.id,
      message,
    ]);
    await note('error', { reason: 'platform', message });
    return { status: 'failed', message };
  }

  // The call is on record before the bookkeeping, so a crash between the two is recoverable.
  await recordEvent(db, {
    orgId: proposal.org_id,
    type: 'external.call',
    subjectTable: 'proposals',
    subjectId: proposal.id,
    requestId,
    outcome: 'ok',
    payload: { action: 'place_bid', platform: proposal.platform, platformRef, sent: payload },
  });
  const pipelineItemId = await recordPlaced(db, proposal, platformRef, requestId, now);
  return { status: 'submitted', platformRef, pipelineItemId };
}

export function createSubmitProcessor(deps: SubmitDeps) {
  return (job: Job<SubmitJobData>): Promise<SubmitResult> =>
    submitProposal(deps, job.data, {
      finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
}

/** One submission per proposal: BullMQ drops an add whose id is already queued. */
export function enqueueSubmit(queue: Queue, data: SubmitJobData) {
  return queue.add('submit', data, { jobId: `submit__${data.proposalId}` });
}
