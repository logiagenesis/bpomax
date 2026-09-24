/**
 * Where every Paystack and Stripe call in this package comes from (docs/01 rule 7). Each
 * was read on 24/09/2026. Paystack's pages were read on docs-v2.paystack.com, the host
 * that serves the same documentation with its code samples rendered.
 */
export const DOC = {
  // Paystack
  paystackApi:
    'https://docs-v2.paystack.com/api/ (base URL https://api.paystack.co; amounts in the subunit: ZAR in cents)',
  paystackInitialize: 'https://paystack.com/docs/api/transaction/#initialize',
  paystackVerify: 'https://docs-v2.paystack.com/api/transaction/#verify',
  paystackFetchSubscription: 'https://docs-v2.paystack.com/api/subscription/#fetch',
  paystackSubscriptions:
    'https://docs-v2.paystack.com/payments/subscriptions/#listen-for-subscription-events',
  paystackStatuses:
    'https://docs-v2.paystack.com/payments/subscriptions/#understanding-subscription-statuses',
  paystackWebhooks: 'https://paystack.com/docs/payments/webhooks/#signature-validation',
  // Stripe
  stripeApi:
    'https://docs.stripe.com/api (base URL https://api.stripe.com; form-encoded bodies, JSON responses)',
  stripeAuth: 'https://docs.stripe.com/api/authentication',
  stripeCheckout: 'https://docs.stripe.com/api/checkout/sessions/create',
  stripeSession: 'https://docs.stripe.com/api/checkout/sessions/object',
  stripeEvent: 'https://docs.stripe.com/api/events/object',
  stripeSubscriptionEvents: 'https://docs.stripe.com/billing/subscriptions/webhooks',
  stripeSignature: 'https://docs.stripe.com/webhooks#verify-manually',
} as const;
