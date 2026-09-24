/**
 * Billing (ARB-420, docs/01 section D `subscriptions`): Paystack for rand and Stripe for
 * US dollars, as the ticket names them. This module holds the rules both share: which
 * provider takes which currency, how each provider's subscription status reads as ours,
 * and the grace period after a failed payment. No figure is set here: prices are the
 * plans' (D-12), and the grace period is the owner's setting (D-070), null until chosen.
 */
export const BILLING_CURRENCIES = ['ZAR', 'USD'] as const;
export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];
export type BillingProvider = 'paystack' | 'stripe';

export const PROVIDER_FOR: Record<BillingCurrency, BillingProvider> = {
  ZAR: 'paystack',
  USD: 'stripe',
};

export function isBillingCurrency(value: unknown): value is BillingCurrency {
  return value === 'ZAR' || value === 'USD';
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

/** What a provider event means for an org's plan. */
export type BillingSignal = 'paid' | 'payment_failed' | 'ended';

/**
 * Stripe's subscription statuses (https://docs.stripe.com/billing/subscriptions/webhooks):
 * `active` and `trialing` are in good standing; `past_due` is a failed payment Stripe may
 * still retry, and so is `paused`, which has no payment method; "When a subscription
 * changes to canceled or unpaid, revoke access", and `incomplete_expired` never started.
 * `incomplete` is a first payment still in progress, and changes nothing.
 */
export function stripeSignal(status: string | null): BillingSignal | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'paid';
    case 'past_due':
    case 'paused':
      return 'payment_failed';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'ended';
    default:
      return null;
  }
}

/**
 * Paystack's subscription statuses
 * (https://docs-v2.paystack.com/payments/subscriptions/#understanding-subscription-statuses):
 * `active`; `non-renewing` is "currently active" until the next payment date; `attention`
 * is "an issue while trying to charge the customer's card"; `completed` and `cancelled`
 * will no longer be charged.
 */
export function paystackSignal(status: string | null): BillingSignal | null {
  switch (status) {
    case 'active':
    case 'non-renewing':
      return 'paid';
    case 'attention':
      return 'payment_failed';
    case 'completed':
    case 'cancelled':
      return 'ended';
    default:
      return null;
  }
}

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  /** When a failed payment's grace period ends; null while none is running or none is set. */
  readonly graceUntil: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The next state after a provider's signal. A failed payment starts the grace period
 * once, and a second failure does not restart it. With no grace period set (null), a
 * failed payment leaves the plan in use until the provider itself ends the subscription:
 * the build does not choose how long a customer may go unpaid.
 */
export function nextSubscriptionState(
  current: SubscriptionState | null,
  signal: BillingSignal,
  now: Date,
  graceDays: number | null,
): SubscriptionState {
  if (signal === 'paid') return { status: 'active', graceUntil: null };
  if (signal === 'ended') return { status: 'cancelled', graceUntil: null };
  if (current?.status === 'past_due') return current;
  return {
    status: 'past_due',
    graceUntil: graceDays === null ? null : new Date(now.getTime() + graceDays * DAY_MS),
  };
}

/** Whether a failed payment's grace period is over, so the plan no longer holds. */
export function graceEnded(state: SubscriptionState, now: Date): boolean {
  return state.status === 'past_due' && state.graceUntil !== null && state.graceUntil <= now;
}
