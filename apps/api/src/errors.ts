/**
 * Postgres errors as HTTP answers. RLS refusals are 403, unique collisions 409, check
 * constraints 422, and each named constraint gets a sentence the operator can act on.
 * The raw driver message is read here and never sent to the page as it is.
 */
export function statusFor(error: unknown): number {
  const message = rawMessage(error);
  if (/row-level security|refused/i.test(message)) return 403;
  if (/duplicate key|unique constraint/i.test(message)) return 409;
  if (/violates check constraint/i.test(message)) return 422;
  return 500;
}

export function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONSTRAINT_WORDS: readonly (readonly [RegExp, string])[] = [
  [/live_mode_requires_margin_rules/i, 'live mode needs every margin rule and a fee table first'],
  [/live_mode_requires_retention_period/i, 'live mode needs the retention period first'],
  [/auto_send_requires_guardrails/i, 'auto-send needs a daily cap and a minimum score'],
  [/scanners_org_id_name_key/i, 'a scanner with that name already exists in this org'],
  [/submission_requires_approval/i, 'a bid cannot be sent without an approval'],
  [/row-level security|refused/i, 'you do not have permission to do that in this org'],
];

export function messageFor(error: unknown): string {
  const message = rawMessage(error);
  for (const [pattern, words] of CONSTRAINT_WORDS) if (pattern.test(message)) return words;
  if (/duplicate key/i.test(message)) return 'that record already exists';
  return message;
}

/** A refusal the route raised itself, carrying the status it wants. */
export function refuse(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function statusOf(error: unknown): number {
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : statusFor(error);
}

export function messageOf(error: unknown): string {
  return typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ? rawMessage(error)
    : messageFor(error);
}
