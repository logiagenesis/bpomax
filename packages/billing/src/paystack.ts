import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderConfig } from './config.js';
import { BillingError, call, text, type Fetch } from './http.js';

/**
 * Paystack, for plans paid in rand (ARB-420). Each call is the documented one, with the
 * secret key as a Bearer token and JSON bodies; an amount is in the currency's subunit,
 * cents for ZAR (DOC.paystackApi).
 */
function headers(config: ProviderConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.secretKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  const inner = body.data;
  return typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : {};
}

export interface PaystackCheckoutInput {
  readonly email: string;
  /** The plan's code on Paystack; "This would invalidate the value provided in amount". */
  readonly planCode: string;
  /** The plan's price in cents, sent as the documented example does beside the plan. */
  readonly amountMinor: number;
  /** Ours: "Only -, ., = and alphanumeric characters allowed". */
  readonly reference: string;
  readonly callbackUrl: string;
  readonly metadata: Record<string, string>;
}

/**
 * `POST /transaction/initialize` with a plan code: "Once the customer pays, they'll
 * automatically be subscribed to the plan" (DOC.paystackInitialize, DOC.paystackSubscriptions).
 */
export async function initializePaystackCheckout(
  config: ProviderConfig,
  input: PaystackCheckoutInput,
  fetchImpl: Fetch = fetch,
): Promise<{ authorizationUrl: string; reference: string }> {
  const body = await call(
    'paystack',
    fetchImpl,
    `${config.baseUrl}/transaction/initialize`,
    {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        email: input.email,
        amount: String(input.amountMinor),
        currency: 'ZAR',
        plan: input.planCode,
        reference: input.reference,
        callback_url: input.callbackUrl,
        // "Stringified JSON object of custom data".
        metadata: JSON.stringify(input.metadata),
      }),
    },
    'start a checkout',
  );
  const result = data(body);
  const authorizationUrl = text(result.authorization_url);
  if (!authorizationUrl) {
    throw new BillingError('Paystack answered without an authorization_url.', 'paystack', 200);
  }
  return { authorizationUrl, reference: text(result.reference) ?? input.reference };
}

export interface PaystackTransaction {
  readonly status: string | null;
  readonly reference: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly customerCode: string | null;
}

/** `GET /transaction/verify/:reference`: what Paystack itself says about a payment (DOC.paystackVerify). */
export async function verifyPaystackTransaction(
  config: ProviderConfig,
  reference: string,
  fetchImpl: Fetch = fetch,
): Promise<PaystackTransaction> {
  const body = await call(
    'paystack',
    fetchImpl,
    `${config.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
    { method: 'GET', headers: headers(config) },
    'confirm a payment',
  );
  const result = data(body);
  const customer = (result.customer ?? {}) as Record<string, unknown>;
  return {
    status: text(result.status),
    reference: text(result.reference),
    amountMinor: typeof result.amount === 'number' ? result.amount : null,
    currency: text(result.currency),
    customerCode: text(customer.customer_code),
  };
}

export interface PaystackSubscription {
  readonly subscriptionCode: string | null;
  /** active, non-renewing, attention, completed or cancelled (DOC.paystackStatuses). */
  readonly status: string | null;
  readonly customerCode: string | null;
  readonly planCode: string | null;
}

/** `GET /subscription/:id_or_code` (DOC.paystackFetchSubscription). */
export async function fetchPaystackSubscription(
  config: ProviderConfig,
  code: string,
  fetchImpl: Fetch = fetch,
): Promise<PaystackSubscription> {
  const body = await call(
    'paystack',
    fetchImpl,
    `${config.baseUrl}/subscription/${encodeURIComponent(code)}`,
    { method: 'GET', headers: headers(config) },
    'read a subscription',
  );
  const result = data(body);
  const customer = (result.customer ?? {}) as Record<string, unknown>;
  const plan = (result.plan ?? {}) as Record<string, unknown>;
  return {
    subscriptionCode: text(result.subscription_code),
    status: text(result.status),
    customerCode: text(customer.customer_code),
    planCode: text(plan.plan_code),
  };
}

/**
 * "The value of this header is a HMAC SHA512 signature of the event payload signed using
 * your secret key" (`x-paystack-signature`, DOC.paystackWebhooks). The raw body is what
 * was signed, so it is checked before anything is parsed. Compared in constant time.
 */
export function verifyPaystackSignature(
  rawBody: string,
  header: string | undefined,
  secretKey: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody, 'utf8').digest('hex');
  const given = Buffer.from(header, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
