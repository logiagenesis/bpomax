import { createHash, randomUUID } from 'node:crypto';
import {
  BILLING_CURRENCIES,
  PROVIDER_FOR,
  isBillingCurrency,
  noPlanMessage,
  paystackSignal,
  stripeSignal,
  validatePlan,
  type BillingCurrency,
  type BillingSignal,
  type Plan,
} from '@arbitron/core';
import {
  BillingError,
  createStripeCheckout,
  fetchPaystackSubscription,
  initializePaystackCheckout,
  verifyPaystackSignature,
  verifyPaystackTransaction,
  verifyStripeSignature,
  type ProviderResult,
} from '@arbitron/billing';
import {
  activatePlan,
  applyBillingSignal,
  findCheckout,
  graceDays,
  inTransaction,
  loadOrgPlan,
  recordEvent,
  recordWebhookReceipt,
  seenWebhook,
  withUser,
  type Queryable,
} from '@arbitron/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { currentMembership, invalid, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Billing (ARB-420): Paystack for plans paid in rand and Stripe for US dollars. The page
 * reads the plans and the org's subscription; an owner starts a checkout at the provider;
 * the providers' webhooks, checked by their documented signatures, move the subscription.
 * Every provider call is in `@arbitron/billing`, each cited from the provider's own
 * documentation. No price, plan or grace period is set here (D-12, D-070).
 */
function providerState(result: ProviderResult<{ environment: string }> | undefined) {
  if (!result) {
    return {
      configured: false,
      environment: null,
      reason: 'Billing is not set up here (docs/02 B-15).',
    };
  }
  return result.ok
    ? { configured: true, environment: result.config.environment, reason: null }
    : { configured: false, environment: null, reason: result.reason };
}

async function listPlans(tx: Queryable): Promise<Plan[]> {
  const { rows } = await tx.query<{
    code: string;
    name: string;
    active: boolean;
    limits: unknown;
    prices: unknown;
  }>('select code, name, active, limits, prices from plans where active order by code');
  const plans: Plan[] = [];
  for (const row of rows) {
    const parsed = validatePlan(row);
    if (parsed.ok) plans.push(parsed.value);
  }
  return plans;
}

export function registerBillingRoutes(app: FastifyInstance, options: ServerOptions): void {
  const now = () => options.now?.() ?? new Date();

  app.get('/v1/billing', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const at = now();
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const loaded = await loadOrgPlan(tx, me.orgId, at);
      const { rows } = await tx.query<{
        plan: string;
        status: string;
        provider: string | null;
        currency: string | null;
        grace_until: Date | string | null;
      }>(
        'select plan, status, provider, currency::text as currency, grace_until from subscriptions where org_id = $1',
        [me.orgId],
      );
      return {
        me,
        orgPlan: loaded?.orgPlan ?? null,
        subscription: rows[0] ?? null,
        plans: await listPlans(tx),
        graceDays: await graceDays(tx),
      };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    const { orgPlan, subscription } = result;
    return reply.send({
      role: result.me.role,
      houseOrg: orgPlan?.kind === 'exempt',
      state:
        orgPlan?.kind === 'none'
          ? { kind: 'none', reason: orgPlan.reason, message: noPlanMessage(orgPlan.reason) }
          : (orgPlan ?? null),
      subscription: subscription && {
        plan: subscription.plan,
        status: subscription.status,
        provider: subscription.provider,
        currency: subscription.currency?.trim() ?? null,
        graceUntil:
          subscription.grace_until === null
            ? null
            : new Date(subscription.grace_until).toISOString(),
      },
      plans: result.plans.map((plan) => ({
        code: plan.code,
        name: plan.name,
        limits: plan.limits,
        prices: BILLING_CURRENCIES.filter((c) => plan.prices[c]).map((currency) => ({
          currency,
          provider: PROVIDER_FOR[currency],
          amountMinor: plan.prices[currency]!.amountMinor,
        })),
      })),
      graceDays: result.graceDays,
      providers: {
        paystack: providerState(options.billing?.config.paystack),
        stripe: providerState(options.billing?.config.stripe),
      },
    });
  });

  /** An owner starts paying for a plan: the provider's hosted checkout page is returned. */
  app.post('/v1/billing/checkout', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const body = (request.body ?? {}) as { plan?: unknown; currency?: unknown };
    const errors = [];
    if (typeof body.plan !== 'string' || !body.plan.trim())
      errors.push({ field: 'plan', message: 'is required' });
    if (!isBillingCurrency(body.currency))
      errors.push({ field: 'currency', message: 'must be ZAR or USD' });
    if (errors.length > 0) return reply.code(422).send(invalid(errors));
    const currency = body.currency as BillingCurrency;
    const provider = PROVIDER_FOR[currency];
    const billing = options.billing;
    const config = billing?.config;
    const providerConfig = provider === 'paystack' ? config?.paystack : config?.stripe;

    try {
      const started = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (me.role !== 'owner') throw refuse(403, 'Only an owner can choose or pay for the plan.');
        const orgPlan = (await loadOrgPlan(tx, me.orgId, now()))?.orgPlan;
        if (orgPlan?.kind === 'exempt')
          throw refuse(409, 'This is the house organisation: it is not billed.');
        const current = await tx.query<{ status: string }>(
          `select status from subscriptions where org_id = $1 and status in ('active', 'past_due', 'trialing')`,
          [me.orgId],
        );
        if (current.rows[0]) {
          throw refuse(
            409,
            'This organisation already has a plan. Changing plan is not built yet (D-070): end the current subscription with the payment provider first.',
          );
        }
        const plan = (await listPlans(tx)).find((p) => p.code === body.plan);
        if (!plan) throw refuse(422, 'That plan is not on sale.');
        const price = plan.prices[currency];
        if (!price) {
          throw refuse(
            422,
            `The ${plan.name} plan is not sold in ${currency === 'ZAR' ? 'rand' : 'US dollars'}.`,
          );
        }
        if (!providerConfig?.ok || !config?.returnUrl) {
          throw refuse(
            503,
            providerConfig && !providerConfig.ok
              ? providerConfig.reason
              : 'Billing is not set up here (docs/02 B-15).',
          );
        }
        if (!me.email) throw refuse(422, 'Your account has no email address for the receipt.');
        const reference = `arb-${randomUUID()}`;
        const inserted = await tx.query<{ id: string }>(
          `insert into billing_checkouts (org_id, provider, plan_code, currency, reference, created_by)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [me.orgId, provider, plan.code, currency, reference, me.userId],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'billing.checkout_started',
          actorUserId: me.userId,
          subjectTable: 'billing_checkouts',
          subjectId: inserted.rows[0]!.id,
          requestId: request.id,
          payload: { plan: plan.code, currency, provider, amountMinor: price.amountMinor },
        });
        return { me, plan, price, reference, checkoutId: inserted.rows[0]!.id };
      });

      const returnUrl = config!.returnUrl!;
      let url: string;
      let session: string | null = null;
      try {
        if (provider === 'paystack') {
          const paystack = config!.paystack;
          if (!paystack.ok) throw new Error('unreachable');
          const price = started.price as { amountMinor: number; paystackPlanCode: string };
          const result = await initializePaystackCheckout(
            paystack.config,
            {
              email: started.me.email!,
              planCode: price.paystackPlanCode,
              amountMinor: price.amountMinor,
              reference: started.reference,
              callbackUrl: `${returnUrl}?checkout=${started.reference}`,
              metadata: { checkoutReference: started.reference, plan: started.plan.code },
            },
            billing?.paystackFetch,
          );
          url = result.authorizationUrl;
        } else {
          const stripe = config!.stripe;
          if (!stripe.ok) throw new Error('unreachable');
          const price = started.price as { amountMinor: number; stripePriceId: string };
          const result = await createStripeCheckout(
            stripe.config,
            {
              priceId: price.stripePriceId,
              successUrl: `${returnUrl}?checkout=${started.reference}`,
              cancelUrl: `${returnUrl}?checkout=cancelled`,
              clientReferenceId: started.reference,
              customerEmail: started.me.email,
              metadata: { checkout_reference: started.reference, plan: started.plan.code },
            },
            billing?.stripeFetch,
          );
          url = result.url;
          session = result.id;
        }
      } catch (error) {
        await options.db.query(`update billing_checkouts set status = 'failed' where id = $1`, [
          started.checkoutId,
        ]);
        const message =
          error instanceof BillingError
            ? error.message
            : 'The payment provider could not be reached.';
        return reply.code(502).send({ error: `${message} Nothing was charged.` });
      }
      if (session) {
        await options.db.query(
          'update billing_checkouts set external_session_id = $2 where id = $1',
          [started.checkoutId, session],
        );
      }
      return reply.code(201).send({ url, provider, reference: started.reference });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  // The webhooks read the raw body: a signature is over the bytes as sent, so the body
  // must not be parsed before it is checked (DOC.paystackWebhooks, DOC.stripeSignature).
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post('/v1/webhooks/paystack', async (request, reply) => {
      const config = options.billing?.config.paystack;
      if (!config?.ok)
        return reply
          .code(503)
          .send({ error: config?.reason ?? 'Billing is not set up here (docs/02 B-15).' });
      const raw = typeof request.body === 'string' ? request.body : '';
      const header = request.headers['x-paystack-signature'];
      if (
        !verifyPaystackSignature(
          raw,
          typeof header === 'string' ? header : undefined,
          config.config.secretKey,
        )
      ) {
        return reply.code(401).send({ error: 'the signature does not match' });
      }
      let event: { event?: unknown; data?: Record<string, unknown> };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return reply.code(400).send({ error: 'the body is not JSON' });
      }
      const type = typeof event.event === 'string' ? event.event : 'unknown';
      // Paystack's events carry no id, so a redelivery is known by its signed body.
      const eventKey = createHash('sha256').update(raw).digest('hex');
      if (await seenWebhook(options.db, 'paystack', eventKey)) {
        return reply.send({ received: true, duplicate: true });
      }
      return settle(
        options,
        reply,
        { provider: 'paystack', eventKey, eventType: type, requestId: request.id },
        () => paystackEvent(options, config.config, type, event.data ?? {}, now(), request.id),
      );
    });

    scope.post('/v1/webhooks/stripe', async (request, reply) => {
      const config = options.billing?.config.stripe;
      if (!config?.ok)
        return reply
          .code(503)
          .send({ error: config?.reason ?? 'Billing is not set up here (docs/02 B-15).' });
      const raw = typeof request.body === 'string' ? request.body : '';
      const header = request.headers['stripe-signature'];
      const check = verifyStripeSignature(
        raw,
        typeof header === 'string' ? header : undefined,
        config.config.webhookSecret,
        Math.floor(now().getTime() / 1000),
      );
      if (!check.ok)
        return reply.code(400).send({ error: `the signature was refused (${check.reason})` });
      let event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return reply.code(400).send({ error: 'the body is not JSON' });
      }
      const type = typeof event.type === 'string' ? event.type : 'unknown';
      const eventKey =
        typeof event.id === 'string' ? event.id : createHash('sha256').update(raw).digest('hex');
      if (await seenWebhook(options.db, 'stripe', eventKey)) {
        return reply.send({ received: true, duplicate: true });
      }
      return settle(
        options,
        reply,
        { provider: 'stripe', eventKey, eventType: type, requestId: request.id },
        () => stripeEvent(options, type, event.data?.object ?? {}, now(), request.id),
      );
    });
  });
}

/**
 * What one event means: which org, and the change to make. `apply` runs inside the
 * receipt's transaction and returns the org it changed, or null when nothing of ours
 * matched (the event may belong to another product on the same provider account).
 */
interface Outcome {
  readonly orgId: string | null;
  readonly outcome: 'ok' | 'skipped';
  readonly detail: string;
  readonly apply?: (tx: Queryable) => Promise<string | null>;
}

const skipped = (detail: string, orgId: string | null = null): Outcome => ({
  orgId,
  outcome: 'skipped',
  detail,
});

/**
 * Reads the event (a provider call may be made, outside any transaction), then records
 * its receipt and applies it in one transaction, so a redelivery is applied once: the
 * receipt is taken first, and a second delivery of the same event waits on it and finds
 * it. A provider that cannot be read is answered non-2xx, so the provider sends it again.
 */
async function settle(
  options: ServerOptions,
  reply: FastifyReply,
  event: {
    provider: 'paystack' | 'stripe';
    eventKey: string;
    eventType: string;
    requestId: string;
  },
  read: () => Promise<Outcome>,
) {
  let planned: Outcome;
  try {
    planned = await read();
  } catch (error) {
    return reply.code(502).send({ error: messageOf(error) });
  }
  const settled = await inTransaction(options.db, async (tx) => {
    const fresh = await recordWebhookReceipt(tx, {
      provider: event.provider,
      eventKey: event.eventKey,
      eventType: event.eventType,
      orgId: planned.orgId,
      outcome: planned.outcome,
      detail: planned.detail,
    });
    if (!fresh) return { duplicate: true as const };
    let { orgId, outcome, detail } = planned;
    if (planned.apply) {
      const applied = await planned.apply(tx);
      if (applied === null) {
        outcome = 'skipped';
        detail = 'no subscription of ours matches';
      } else {
        orgId = applied;
      }
      await tx.query(
        `update billing_webhook_receipts set org_id = $3, outcome = $4, detail = $5
          where provider = $1 and event_key = $2`,
        [event.provider, event.eventKey, orgId, outcome, detail],
      );
    }
    if (orgId) {
      await recordEvent(tx, {
        orgId,
        type: 'billing.webhook_received',
        requestId: event.requestId,
        outcome,
        payload: { provider: event.provider, eventType: event.eventType, detail },
      });
    }
    return { duplicate: false as const, outcome, detail };
  });
  return reply.send({ received: true, ...settled });
}

type PaystackConfig = Extract<
  NonNullable<ServerOptions['billing']>['config']['paystack'],
  { ok: true }
>['config'];

async function paystackEvent(
  options: ServerOptions,
  config: PaystackConfig,
  type: string,
  data: Record<string, unknown>,
  now: Date,
  requestId: string,
): Promise<Outcome> {
  const fetchImpl = options.billing?.paystackFetch;
  const days = await graceDays(options.db);
  const bySignal = (
    customerCode: string,
    externalRef: string | null,
    signal: BillingSignal,
  ): Outcome => ({
    orgId: null,
    outcome: 'ok',
    detail: signal,
    apply: async (tx) =>
      (
        await applyBillingSignal(tx, {
          match: { provider: 'paystack', externalCustomer: customerCode },
          signal,
          now,
          graceDays: days,
          externalRef,
          requestId,
        })
      )?.orgId ?? null,
  });

  if (type === 'charge.success') {
    const reference = typeof data.reference === 'string' ? data.reference : null;
    if (!reference) return skipped('no reference');
    // What Paystack itself says about the payment, not what the event body claims
    // (DOC.paystackVerify).
    const payment = await verifyPaystackTransaction(config, reference, fetchImpl);
    if (payment.status !== 'success')
      return skipped(`the payment is ${payment.status ?? 'unknown'}`);
    const checkout = await findCheckout(options.db, { reference });
    if (checkout?.provider === 'paystack') {
      return {
        orgId: checkout.org_id,
        outcome: 'ok',
        detail: `plan ${checkout.plan_code} activated`,
        apply: async (tx) => {
          await activatePlan(tx, {
            checkout,
            externalRef: null,
            externalCustomer: payment.customerCode,
            requestId,
          });
          return checkout.org_id;
        },
      };
    }
    // Not a checkout of ours: a renewal, paid.
    return payment.customerCode
      ? bySignal(payment.customerCode, null, 'paid')
      : skipped('no checkout or customer to match');
  }

  // Invoices carry the subscription (DOC.paystackSubscriptions); subscription events are
  // the subscription. Either way, its state is read from Paystack itself.
  const code = type.startsWith('invoice.')
    ? (data.subscription as { subscription_code?: unknown } | undefined)?.subscription_code
    : type.startsWith('subscription.')
      ? data.subscription_code
      : null;
  if (typeof code !== 'string') return skipped(`${type} is not acted on`);
  const subscription = await fetchPaystackSubscription(config, code, fetchImpl);
  const signal = paystackSignal(subscription.status);
  if (!signal || !subscription.customerCode) {
    return skipped(`status ${subscription.status ?? 'unknown'} changes nothing`);
  }
  return bySignal(subscription.customerCode, code, signal);
}

async function stripeEvent(
  options: ServerOptions,
  type: string,
  object: Record<string, unknown>,
  now: Date,
  requestId: string,
): Promise<Outcome> {
  if (type === 'checkout.session.completed') {
    const reference =
      typeof object.client_reference_id === 'string' ? object.client_reference_id : null;
    const checkout = reference ? await findCheckout(options.db, { reference }) : null;
    if (checkout?.provider !== 'stripe') return skipped('no checkout of ours matches');
    // "paid: The payment funds are available in your account" (DOC.stripeSession).
    if (object.payment_status !== 'paid') {
      return skipped(`the payment is ${String(object.payment_status)}`, checkout.org_id);
    }
    return {
      orgId: checkout.org_id,
      outcome: 'ok',
      detail: `plan ${checkout.plan_code} activated`,
      apply: async (tx) => {
        await activatePlan(tx, {
          checkout,
          externalRef: typeof object.subscription === 'string' ? object.subscription : null,
          externalCustomer: typeof object.customer === 'string' ? object.customer : null,
          requestId,
        });
        return checkout.org_id;
      },
    };
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const id = typeof object.id === 'string' ? object.id : null;
    const signal = stripeSignal(typeof object.status === 'string' ? object.status : null);
    if (!id || !signal) return skipped(`status ${String(object.status)} changes nothing`);
    const days = await graceDays(options.db);
    return {
      orgId: null,
      outcome: 'ok',
      detail: signal,
      apply: async (tx) =>
        (
          await applyBillingSignal(tx, {
            match: { provider: 'stripe', externalRef: id },
            signal,
            now,
            graceDays: days,
            requestId,
          })
        )?.orgId ?? null,
    };
  }
  return skipped(`${type} is not acted on`);
}
