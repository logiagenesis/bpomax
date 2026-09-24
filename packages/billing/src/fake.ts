import { createHmac } from 'node:crypto';
import type { Fetch } from './http.js';

/**
 * Stand-ins of Paystack and Stripe (ARB-420), for tests and local development. Each
 * answers the calls in `paystack.ts` and `stripe.ts` in the documented shapes, refuses a
 * wrong key, and can produce the webhook events a payment, a failed renewal or a
 * cancellation would send, signed the documented way. No real account is touched.
 */
export const PAYSTACK_STAND_IN = 'https://paystack.stand-in.test';
export const STRIPE_STAND_IN = 'https://stripe.stand-in.test';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface PaystackTransactionState {
  status: 'abandoned' | 'success' | 'failed';
  reference: string;
  amount: number;
  currency: string;
  email: string;
  planCode: string;
  customerCode: string | null;
  metadata: string;
}

interface PaystackSubscriptionState {
  code: string;
  status: 'active' | 'non-renewing' | 'attention' | 'completed' | 'cancelled';
  customerCode: string;
  planCode: string;
}

export function createFakePaystack(secretKey = 'sk_stand_in_paystack', origin = PAYSTACK_STAND_IN) {
  const transactions = new Map<string, PaystackTransactionState>();
  const subscriptions = new Map<string, PaystackSubscriptionState>();
  const initialized: Record<string, unknown>[] = [];
  let counter = 0;

  const fetchImpl: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== origin) return json(404, { status: false, message: 'not the stand-in' });
    if (new Headers(init.headers).get('authorization') !== `Bearer ${secretKey}`) {
      return json(401, { status: false, message: 'Invalid key' });
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/transaction/initialize') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      initialized.push(body);
      if (typeof body.email !== 'string' || typeof body.plan !== 'string') {
        return json(400, { status: false, message: 'email and plan are required here' });
      }
      const reference = String(body.reference ?? `ref-${String((counter += 1))}`);
      transactions.set(reference, {
        status: 'abandoned',
        reference,
        amount: Number(body.amount),
        currency: String(body.currency ?? 'ZAR'),
        email: body.email,
        planCode: body.plan,
        customerCode: null,
        metadata: String(body.metadata ?? ''),
      });
      return json(200, {
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: `${origin}/checkout/${reference}`,
          access_code: `access-${reference}`,
          reference,
        },
      });
    }
    const verify = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
    if (method === 'GET' && verify) {
      const tx = transactions.get(decodeURIComponent(verify[1]!));
      if (!tx) return json(400, { status: false, message: 'Transaction reference not found' });
      return json(200, {
        status: true,
        message: 'Verification successful',
        data: {
          status: tx.status,
          reference: tx.reference,
          amount: tx.amount,
          currency: tx.currency,
          metadata: tx.metadata,
          customer: { email: tx.email, customer_code: tx.customerCode },
          plan: tx.planCode,
        },
      });
    }
    const fetchSub = /^\/subscription\/(.+)$/.exec(url.pathname);
    if (method === 'GET' && fetchSub) {
      const sub = subscriptions.get(decodeURIComponent(fetchSub[1]!));
      if (!sub) return json(404, { status: false, message: 'Subscription not found' });
      return json(200, {
        status: true,
        message: 'Subscription retrieved successfully',
        data: {
          subscription_code: sub.code,
          status: sub.status,
          customer: { customer_code: sub.customerCode },
          plan: { plan_code: sub.planCode },
        },
      });
    }
    return json(404, { status: false, message: `the stand-in has no ${method} ${url.pathname}` });
  };

  /** The customer pays: the transaction succeeds and a subscription starts. */
  function pay(reference: string) {
    const tx = transactions.get(reference);
    if (!tx) throw new Error(`no transaction ${reference}`);
    counter += 1;
    tx.status = 'success';
    tx.customerCode = `CUS_standin${String(counter)}`;
    const code = `SUB_standin${String(counter)}`;
    subscriptions.set(code, {
      code,
      status: 'active',
      customerCode: tx.customerCode,
      planCode: tx.planCode,
    });
    return {
      subscriptionCode: code,
      customerCode: tx.customerCode,
      event: {
        event: 'charge.success',
        data: { reference, status: 'success', amount: tx.amount, currency: tx.currency },
      },
    };
  }

  /** A renewal fails: the subscription needs attention (DOC.paystackStatuses). */
  function failRenewal(code: string) {
    const sub = subscriptions.get(code);
    if (!sub) throw new Error(`no subscription ${code}`);
    sub.status = 'attention';
    return {
      event: 'invoice.payment_failed',
      data: {
        status: 'failed',
        paid: false,
        subscription: { subscription_code: code, status: 'attention' },
        customer: { customer_code: sub.customerCode },
      },
    };
  }

  /** A renewal is paid after all: an invoice update for the subscription. */
  function payRenewal(code: string) {
    const sub = subscriptions.get(code);
    if (!sub) throw new Error(`no subscription ${code}`);
    sub.status = 'active';
    return {
      event: 'invoice.update',
      data: {
        status: 'success',
        paid: true,
        subscription: { subscription_code: code, status: 'active' },
        customer: { customer_code: sub.customerCode },
      },
    };
  }

  /** The subscription ends. */
  function disable(code: string) {
    const sub = subscriptions.get(code);
    if (!sub) throw new Error(`no subscription ${code}`);
    sub.status = 'cancelled';
    return {
      event: 'subscription.disable',
      data: { subscription_code: code, status: 'cancelled' },
    };
  }

  /** `x-paystack-signature` for a body, as Paystack computes it. */
  function sign(body: string, key = secretKey): string {
    return createHmac('sha512', key).update(body, 'utf8').digest('hex');
  }

  return {
    origin,
    secretKey,
    fetch: fetchImpl,
    transactions,
    subscriptions,
    initialized,
    pay,
    failRenewal,
    payRenewal,
    disable,
    sign,
  };
}

interface StripeSessionState {
  id: string;
  url: string;
  price: string;
  clientReferenceId: string | null;
  customerEmail: string | null;
  metadata: Record<string, string>;
  subscription: string | null;
  customer: string | null;
}

export function createFakeStripe(
  secretKey = 'sk_test_stand_in',
  webhookSecret = 'whsec_stand_in',
  origin = STRIPE_STAND_IN,
) {
  const sessions = new Map<string, StripeSessionState>();
  const created: URLSearchParams[] = [];
  let counter = 0;
  const expectedAuth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  const fetchImpl: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== origin) return json(404, { error: { message: 'not the stand-in' } });
    if (new Headers(init.headers).get('authorization') !== expectedAuth) {
      return json(401, { error: { message: 'Invalid API Key provided' } });
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const form = new URLSearchParams(String(init.body ?? ''));
      created.push(form);
      if (form.get('mode') !== 'subscription' || !form.get('line_items[0][price]')) {
        return json(400, { error: { message: 'mode subscription and a price are required here' } });
      }
      counter += 1;
      const id = `cs_test_standin${String(counter)}`;
      const metadata: Record<string, string> = {};
      for (const [key, value] of form) {
        const match = /^metadata\[(.+)\]$/.exec(key);
        if (match) metadata[match[1]!] = value;
      }
      const session: StripeSessionState = {
        id,
        url: `${origin}/pay/${id}`,
        price: form.get('line_items[0][price]')!,
        clientReferenceId: form.get('client_reference_id'),
        customerEmail: form.get('customer_email'),
        metadata,
        subscription: null,
        customer: null,
      };
      sessions.set(id, session);
      return json(200, { id, object: 'checkout.session', mode: 'subscription', url: session.url });
    }
    return json(404, { error: { message: `the stand-in has no ${method} ${url.pathname}` } });
  };

  function event(type: string, object: Record<string, unknown>) {
    counter += 1;
    return {
      id: `evt_standin${String(counter)}`,
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
    };
  }

  /** The customer pays at checkout: a subscription starts. */
  function complete(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    counter += 1;
    session.subscription = `sub_standin${String(counter)}`;
    session.customer = `cus_standin${String(counter)}`;
    return event('checkout.session.completed', {
      id: session.id,
      object: 'checkout.session',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: session.clientReferenceId,
      customer: session.customer,
      subscription: session.subscription,
      metadata: session.metadata,
    });
  }

  /** The subscription changes status, as it does when a renewal fails or is paid. */
  function subscriptionUpdated(subscriptionId: string, status: string) {
    return event('customer.subscription.updated', {
      id: subscriptionId,
      object: 'subscription',
      status,
    });
  }

  function subscriptionDeleted(subscriptionId: string) {
    return event('customer.subscription.deleted', {
      id: subscriptionId,
      object: 'subscription',
      status: 'canceled',
    });
  }

  /** `Stripe-Signature` for a body at a time, as Stripe computes it. */
  function sign(body: string, timestamp: number, secret = webhookSecret): string {
    const v1 = createHmac('sha256', secret)
      .update(`${String(timestamp)}.${body}`, 'utf8')
      .digest('hex');
    return `t=${String(timestamp)},v1=${v1}`;
  }

  return {
    origin,
    secretKey,
    webhookSecret,
    fetch: fetchImpl,
    sessions,
    created,
    complete,
    subscriptionUpdated,
    subscriptionDeleted,
    sign,
  };
}
