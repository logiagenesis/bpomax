import { DOC } from './docs.js';

/**
 * Billing settings (ARB-420). docs/01 section J names PAYSTACK_SECRET_KEY,
 * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET; the accounts are docs/02 B-15. Paystack
 * signs its webhooks with the same secret key (DOC.paystackWebhooks); Stripe signs with
 * the endpoint's own secret (DOC.stripeSignature).
 *
 * The hosts are the documented ones: `https://api.paystack.co` (DOC.paystackApi) and
 * `https://api.stripe.com` (DOC.stripeApi). PAYSTACK_BASE_URL and STRIPE_BASE_URL, for
 * tests and local development only (not in section J, so not in .env.example), point at
 * the stand-ins in `fake.ts`; they are never a default, and the billing page says when one
 * is in use (D-036).
 */
export type BillingEnvironment = 'test' | 'live' | 'unknown' | 'stand-in';

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly environment: BillingEnvironment;
}

export interface StripeConfig extends ProviderConfig {
  readonly webhookSecret: string;
}

export type ProviderResult<T> =
  { readonly ok: true; readonly config: T } | { readonly ok: false; readonly reason: string };

export interface BillingConfig {
  readonly paystack: ProviderResult<ProviderConfig>;
  readonly stripe: ProviderResult<StripeConfig>;
  /** Where the providers send the browser back to: `${APP_URL}/billing.html`. */
  readonly returnUrl: string | null;
}

export const PAYSTACK_BASE_URL = 'https://api.paystack.co';
export const STRIPE_BASE_URL = 'https://api.stripe.com';

function standIn(value: string | undefined, realHost: string): string | null {
  const url = value?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(realHost) ? null : url.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function billingConfig(env: Readonly<Record<string, string | undefined>>): BillingConfig {
  const paystackKey = env.PAYSTACK_SECRET_KEY?.trim();
  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  const stripeHook = env.STRIPE_WEBHOOK_SECRET?.trim();
  const paystackStandIn = standIn(env.PAYSTACK_BASE_URL, 'paystack.co');
  const stripeStandIn = standIn(env.STRIPE_BASE_URL, 'stripe.com');

  let returnUrl: string | null = null;
  try {
    if (env.APP_URL?.trim()) returnUrl = new URL('billing.html', `${env.APP_URL.trim()}/`).href;
  } catch {
    returnUrl = null;
  }

  const paystack: ProviderResult<ProviderConfig> = !paystackKey
    ? {
        ok: false,
        reason: `Paystack is not configured: PAYSTACK_SECRET_KEY is not set. It comes from the Paystack account (docs/02 B-15; ${DOC.paystackApi}).`,
      }
    : !returnUrl
      ? { ok: false, reason: 'Paystack is not configured: APP_URL is not set.' }
      : {
          ok: true,
          config: {
            baseUrl: paystackStandIn ?? PAYSTACK_BASE_URL,
            secretKey: paystackKey,
            // Paystack's pages read for this ticket do not state its key prefixes, so the
            // mode is not guessed from the key.
            environment: paystackStandIn ? 'stand-in' : 'unknown',
          },
        };

  const stripeMissing = [
    ...(stripeKey ? [] : ['STRIPE_SECRET_KEY']),
    ...(stripeHook ? [] : ['STRIPE_WEBHOOK_SECRET']),
  ];
  const stripe: ProviderResult<StripeConfig> =
    stripeMissing.length > 0 || !stripeKey || !stripeHook
      ? {
          ok: false,
          reason: `Stripe is not configured: ${stripeMissing.join(' and ')} ${stripeMissing.length === 1 ? 'is' : 'are'} not set. They come from the Stripe account (docs/02 B-15; ${DOC.stripeAuth}).`,
        }
      : !returnUrl
        ? { ok: false, reason: 'Stripe is not configured: APP_URL is not set.' }
        : {
            ok: true,
            config: {
              baseUrl: stripeStandIn ?? STRIPE_BASE_URL,
              secretKey: stripeKey,
              webhookSecret: stripeHook,
              // "Test mode secret keys start with sk_test_" (DOC.stripeAuth).
              environment: stripeStandIn
                ? 'stand-in'
                : stripeKey.startsWith('sk_test_')
                  ? 'test'
                  : stripeKey.startsWith('sk_live_')
                    ? 'live'
                    : 'unknown',
            },
          };

  return { paystack, stripe, returnUrl };
}
