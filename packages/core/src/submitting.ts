/**
 * The submit worker's rules (ARB-044, docs/01 sections E and H): "approval required,
 * daily cap, LIVE_MODE gate, pipeline item creation". What may leave the building is
 * decided here; the marketplace call itself is an adapter the worker is given.
 */

/** SAST is UTC+2 all year (D-024); a daily cap is a calendar day in that time. */
const HOME_OFFSET_MS = 2 * 60 * 60 * 1000;

/** The South African calendar day `now` falls in, YYYY-MM-DD: what `usage_counters.period_start` holds for a daily cap. */
export function capDay(now: Date): string {
  return new Date(now.getTime() + HOME_OFFSET_MS).toISOString().slice(0, 10);
}

/** The `usage_counters.metric` for a scanner's auto-sent bids. */
export function autoSendMetric(scannerId: string): string {
  return `auto_send:${scannerId}`;
}

export interface LiveGateInput {
  /** LIVE_MODE from the environment: the deployment-wide switch (docs/01 section H). */
  readonly envLiveMode: boolean;
  /** `settings.live_mode` for the org: the owner's switch, which the database refuses until the margin rules and retention period are set. */
  readonly orgLiveMode: boolean;
}

export type LiveGate =
  | { readonly live: true }
  | {
      readonly live: false;
      readonly closedBy: 'environment' | 'org' | 'both';
      readonly message: string;
    };

/** Both switches must be on. Either off means nothing is sent and the would-send payload is logged. */
export function liveGate(input: LiveGateInput): LiveGate {
  if (input.envLiveMode && input.orgLiveMode) return { live: true };
  const closedBy =
    !input.envLiveMode && !input.orgLiveMode ? 'both' : !input.envLiveMode ? 'environment' : 'org';
  const what =
    closedBy === 'both'
      ? 'LIVE_MODE is false and the organisation has not switched live mode on'
      : closedBy === 'environment'
        ? 'LIVE_MODE is false in this environment'
        : 'the organisation has not switched live mode on';
  return {
    live: false,
    closedBy,
    message: `Not sent: ${what}. The bid that would have been sent is in the audit log.`,
  };
}

export const PROPOSAL_STATUSES = [
  'draft',
  'queued',
  'approved',
  'rejected',
  'submitted',
  'failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface SubmittableProposal {
  readonly status: ProposalStatus;
  readonly approvedBy: string | null;
  readonly approvedVia: 'telegram' | 'web' | 'auto' | null;
}

export type ApprovalCheck =
  | { readonly ok: true; readonly via: 'telegram' | 'web' | 'auto' }
  | {
      readonly ok: false;
      readonly reason: 'not_approved' | 'already_submitted' | 'approval_incomplete';
    };

/** "Every outbound action requires approval": a proposal is sent only from `approved`, with a named approver and channel. */
export function checkApproval(proposal: SubmittableProposal): ApprovalCheck {
  if (proposal.status === 'submitted') return { ok: false, reason: 'already_submitted' };
  if (proposal.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (!proposal.approvedBy || !proposal.approvedVia)
    return { ok: false, reason: 'approval_incomplete' };
  return { ok: true, via: proposal.approvedVia };
}

export interface BidMilestone {
  readonly title: string;
  readonly amount_minor: number;
}

/**
 * What the marketplace would be sent for a proposal: the fields, not an endpoint. The
 * endpoint and its parameter names belong to the platform client (ARB-020), cited from
 * the official docs there (01 section B).
 */
export interface BidPayload {
  readonly action: 'place_bid';
  readonly platform: string;
  readonly jobExternalId: string;
  readonly proposalId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly deliveryDays: number;
  readonly milestones: readonly BidMilestone[];
  readonly body: string;
}

export function bidPayload(input: Omit<BidPayload, 'action'>): BidPayload {
  const total = input.milestones.reduce((sum, m) => sum + m.amount_minor, 0);
  if (input.milestones.length > 0 && total !== input.amountMinor) {
    throw new Error(
      `milestones sum to ${String(total)} but the bid is ${String(input.amountMinor)} (05 section 3.5)`,
    );
  }
  return { action: 'place_bid', ...input };
}
