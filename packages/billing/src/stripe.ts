import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderConfig, StripeConfig } from './config.js';
import { BillingError, call, text, type Fetch } from './http.js';

/**
 * Stripe, for plans paid in US dollars (ARB-420). "Provide your API key as the basic auth
 * username value" (DOC.stripeAuth); bodies are form-encoded and answers JSON
 * (DOC.stripeApi).
 */
function headers(config: ProviderConfig): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
}

export interface StripeCheckoutInput {
  /** The plan's recurring Price on Stripe. */
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** "can be used to reconcile the session with your internal systems": our checkout id. */
  readonly clientReferenceId: string;
  readonly customerEmail: string | null;
  readonly metadata: Record<string, string>;
}

/**
 * `POST /v1/checkout/sessions` in `subscription` mode: "Pass subscription if the Checkout
 * Session includes at least one recurring item" (DOC.stripeCheckout). The answer's `url`
 * is where to send the customer (DOC.stripeSession).
 */
export async function createStripeCheckout(
  config: StripeConfig,
  input: StripeCheckoutInput,
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', input.priceId);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', input.successUrl);
  form.set('cancel_url', input.cancelUrl);
  form.set('client_reference_id', input.clientReferenceId);
  if (input.customerEmail) form.set('customer_email', input.customerEmail);
  for (const [key, value] of Object.entries(input.metadata)) form.set(`metadata[${key}]`, value);
  const body = await call(
    'stripe',
    fetchImpl,
    `${config.baseUrl}/v1/checkout/sessions`,
    { method: 'POST', headers: headers(config), body: form.toString() },
    'start a checkout',
  );
  const id = text(body.id);
  const url = text(body.url);
  if (!id || !url)
    throw new BillingError('Stripe answered without a session id and url.', 'stripe', 200);
  return { id, url };
}

/** "Our libraries have a default tolerance of 5 minutes" (DOC.stripeSignature). */
export const STRIPE_TOLERANCE_SECONDS = 300;

export type StripeSignatureCheck =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: 'no_header' | 'no_match' | 'too_old' };

/**
 * The manual check (DOC.stripeSignature): split `Stripe-Signature` on `,` then `=`; `t`
 * is the timestamp and each `v1` a signature; `signed_payload` is the timestamp, `.`,
 * and the raw body; the expected signature is its HMAC-SHA256 with the endpoint secret;
 * compare in constant time with each `v1`, then hold the timestamp to the tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = STRIPE_TOLERANCE_SECONDS,
): StripeSignatureCheck {
  if (!header) return { ok: false, reason: 'no_header' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const element of header.split(',')) {
    const at = element.indexOf('=');
    if (at < 0) continue;
    const prefix = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (prefix === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (prefix === 'v1') signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'no_header' };
  const expected = Buffer.from(
    createHmac('sha256', secret)
      .update(`${String(timestamp)}.${rawBody}`, 'utf8')
      .digest('hex'),
    'utf8',
  );
  const match = signatures.some((signature) => {
    const given = Buffer.from(signature, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) return { ok: false, reason: 'no_match' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'too_old' };
  return { ok: true, timestamp };
}
