import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Outbound messages (ARB-122, docs/01 section H): "every outbound action (bid, message,
 * …) requires approval", and LIVE_MODE=false blocks the send. What a draft must be, and
 * the state an outbound message is in, read from its columns rather than kept in one.
 */
/** The form's own limit; Freelancer.com's, if any, is not documented and is not guessed. */
export const MAX_MESSAGE_LENGTH = 4000;

export interface MessageDraftInput {
  readonly text: string;
}

export function validateMessageDraft(input: unknown): ValidationResult<MessageDraftInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const text = typeof raw.body === 'string' ? raw.body.trim() : null;
  if (text === null) errors.push({ field: 'body', message: 'must be text' });
  else if (text.length === 0) errors.push({ field: 'body', message: 'must not be empty' });
  else if (text.length > MAX_MESSAGE_LENGTH) {
    errors.push({
      field: 'body',
      message: `must be ${String(MAX_MESSAGE_LENGTH)} characters or fewer`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { text: text ?? '' } };
}

export const OUTBOUND_MESSAGE_STATES = [
  'queued',
  'approved',
  'sent',
  'rejected',
  'failed',
] as const;
export type OutboundMessageState = (typeof OUTBOUND_MESSAGE_STATES)[number];

export interface OutboundMessageColumns {
  readonly sentAt: string | Date | null;
  readonly approvedBy: string | null;
  readonly rejectedAt: string | Date | null;
  readonly failureReason: string | null;
}

/** The state, in the order the columns decide it: sent beats everything, then rejected, failed, approved. */
export function outboundMessageState(columns: OutboundMessageColumns): OutboundMessageState {
  if (columns.sentAt) return 'sent';
  if (columns.rejectedAt) return 'rejected';
  if (columns.failureReason) return 'failed';
  if (columns.approvedBy) return 'approved';
  return 'queued';
}
