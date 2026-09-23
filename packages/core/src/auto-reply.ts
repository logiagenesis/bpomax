import type { FieldError, ValidationResult } from './scanners.js';

/**
 * The auto-reply rule (ARB-121, docs/01 section E "auto-reply": "Sends the configured
 * first reply once per thread only", and docs/02 D-08, the wording). What is checked
 * here is checked again by the API; the wording itself is the owner's and is not
 * written by the build.
 */
export const MAX_AUTO_REPLY_LENGTH = 2000;
export const MIN_OFFLINE_AFTER_MINUTES = 1;
export const MAX_OFFLINE_AFTER_MINUTES = 1440;
export const DEFAULT_OFFLINE_AFTER_MINUTES = 30;

export interface AutoReplyInput {
  readonly body: string;
  readonly active: boolean;
  readonly offlineAfterMinutes: number;
}

export function validateAutoReply(input: unknown): ValidationResult<AutoReplyInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  const body = typeof raw.body === 'string' ? raw.body.trim() : null;
  if (body === null) errors.push({ field: 'body', message: 'must be text' });
  else if (body.length > MAX_AUTO_REPLY_LENGTH) {
    errors.push({
      field: 'body',
      message: `must be ${String(MAX_AUTO_REPLY_LENGTH)} characters or fewer`,
    });
  }

  const active = raw.active === true || raw.active === 'true' || raw.active === 'on';
  if (
    raw.active !== undefined &&
    typeof raw.active !== 'boolean' &&
    raw.active !== 'true' &&
    raw.active !== 'on' &&
    raw.active !== 'false' &&
    raw.active !== ''
  ) {
    errors.push({ field: 'active', message: 'must be on or off' });
  }
  if (active && body !== null && body.length === 0) {
    errors.push({ field: 'body', message: 'must not be empty while the auto-reply is on' });
  }

  const minutesRaw = raw.offlineAfterMinutes;
  const minutes =
    minutesRaw === undefined || minutesRaw === '' || minutesRaw === null
      ? DEFAULT_OFFLINE_AFTER_MINUTES
      : typeof minutesRaw === 'number'
        ? minutesRaw
        : typeof minutesRaw === 'string' && /^\d+$/.test(minutesRaw.trim())
          ? Number(minutesRaw.trim())
          : Number.NaN;
  if (!Number.isInteger(minutes)) {
    errors.push({ field: 'offlineAfterMinutes', message: 'must be a whole number of minutes' });
  } else if (minutes < MIN_OFFLINE_AFTER_MINUTES || minutes > MAX_OFFLINE_AFTER_MINUTES) {
    errors.push({
      field: 'offlineAfterMinutes',
      message: `must be between ${String(MIN_OFFLINE_AFTER_MINUTES)} and ${String(MAX_OFFLINE_AFTER_MINUTES)} minutes`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { body: body ?? '', active, offlineAfterMinutes: minutes } };
}

/**
 * Whether the operator counts as offline: no message has left the org, from the app or
 * from the marketplace itself, for `offlineAfterMinutes`. The first client message on a
 * thread nobody has answered is what the reply is for.
 */
export function operatorIsOffline(input: {
  readonly lastOutboundAt: Date | null;
  readonly now: Date;
  readonly offlineAfterMinutes: number;
}): boolean {
  if (input.lastOutboundAt === null) return true;
  return input.now.getTime() - input.lastOutboundAt.getTime() >= input.offlineAfterMinutes * 60_000;
}
