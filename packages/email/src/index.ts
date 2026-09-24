/**
 * @arbitron/email — how the product sends an email (ARB-410's usage alerts, and later
 * ARB-420's billing notices), without choosing who delivers it.
 *
 * The provider is the owner's choice (docs/02 B-13: "Choose provider, verify sending
 * domain"), and every call to one would have to be cited from its documentation (docs/01
 * rule 7). None is chosen, so no provider adapter exists: `emailConfig` says so, the
 * callers skip email and record that they did, and the tests use the stand-in in
 * `./fake`. Adding a provider means one adapter implementing `EmailSender`.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. No HTML until a provider and a template are chosen. */
  readonly text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type EmailConfigResult =
  | { readonly ok: true; readonly sender: EmailSender }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether email can be sent from this environment. Always not yet: EMAIL_PROVIDER_KEY
 * (docs/01 section J) is a key for a provider nobody has chosen, so there is no adapter
 * to hand it to. The reason names B-13 either way.
 */
export function emailConfig(env: Record<string, string | undefined>): EmailConfigResult {
  const key = env.EMAIL_PROVIDER_KEY?.trim();
  return {
    ok: false,
    reason: key
      ? 'EMAIL_PROVIDER_KEY is set, but no email provider is chosen yet, so there is no adapter to use it with (docs/02 B-13).'
      : 'No email provider is configured (docs/02 B-13), so no email is sent.',
  };
}

/** An address worth trying: one @, something either side, no spaces. */
export function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
