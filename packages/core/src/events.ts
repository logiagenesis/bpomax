/**
 * The audit log's vocabulary (ARB-014, docs/01 section D).
 *
 * `events` records every state change and every external call, and it is append-only in
 * the database (migration 0007). A type that is not listed here is refused before it
 * reaches the table, so the log stays searchable rather than becoming free text.
 */
export const EVENT_TYPES = [
  // identity and access
  'auth.signed_in',
  'auth.member_invited',
  'auth.member_role_changed',
  'auth.member_removed',
  // marketplace accounts and scanners
  'account.connect_started',
  'account.connected',
  'account.disconnected',
  'account.token_refreshed',
  'scanner.created',
  'scanner.updated',
  'scanner.deleted',
  'scanner.polled',
  // the pipeline
  'job.ingested',
  'job.scored',
  'estimate.created',
  'margin.evaluated',
  'proposal.draft_requested',
  'proposal.drafted',
  'proposal.edited',
  'proposal.approved',
  'proposal.rejected',
  'proposal.submitted',
  'pipeline.stage_changed',
  // conversation
  'message.received',
  'message.drafted',
  'message.edited',
  'message.rejected',
  'inbox.synced',
  'message.approved',
  'message.sent',
  'auto_reply.sent',
  'discovery.updated',
  'brief.drafted',
  'brief.updated',
  'brief.locked',
  // sourcing and delivery
  'sourcing.requested',
  'sourcing.shortlisted',
  'sourcing.post_approved',
  'sourcing.posted',
  'supplier.imported',
  'supplier.candidate_added',
  'delivery.order_created',
  'payment.recorded',
  // governance
  'telegram.linked',
  'bidding.paused',
  'bidding.resumed',
  'settings.changed',
  'live_mode.changed',
  'external.call',
  'external.blocked_by_live_mode',
  'retention.purged',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_OUTCOMES = ['ok', 'error', 'blocked', 'skipped'] as const;

export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

export const ACTOR_KINDS = ['user', 'system'] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface EventInput {
  readonly orgId: string;
  readonly type: EventType;
  /** Null for worker actions with no human behind them. */
  readonly actorUserId?: string | null;
  readonly actorKind?: ActorKind;
  readonly subjectTable?: string | null;
  readonly subjectId?: string | null;
  /** Ties every event written while serving one request together. */
  readonly requestId?: string | null;
  readonly outcome?: EventOutcome | null;
  /** For a blocked outbound call, what would have been sent (01 section H). */
  readonly payload?: Record<string, unknown>;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Throws rather than writing an event nobody will be able to search for. */
export function assertEventType(value: string): EventType {
  if (!isEventType(value)) {
    throw new Error(
      `unknown event type "${value}". Add it to EVENT_TYPES in packages/core/src/events.ts first.`,
    );
  }
  return value;
}

/** A user event needs a user; a system event must not claim one. */
export function assertActorIsConsistent(event: EventInput): void {
  const kind = event.actorKind ?? (event.actorUserId ? 'user' : 'system');
  if (kind === 'user' && !event.actorUserId) {
    throw new Error(`event "${event.type}" is marked as a user action but names no user`);
  }
  if (kind === 'system' && event.actorUserId) {
    throw new Error(`event "${event.type}" is marked as a system action but names a user`);
  }
}
