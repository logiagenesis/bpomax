import { billingConfig } from '@arbitron/billing';
import { createFakePaystack, createFakeStripe } from '@arbitron/billing/fake';
import { downgradeExpired, loadOrgPlan, planUsage } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-420 acceptance: "Test-mode checkout activates plan; failed payment downgrades after
 * grace period", for Paystack (rand) and Stripe (US dollars), each against its stand-in,
 * which answers in the documented shapes and signs its webhooks the documented way. The
 * plan, its prices and the 7-day grace period are test values: the real ones are D-12's
 * and D-070's.
 */
const START = new Date('2026-09-24T08:00:00Z');
let clock = START;
const HOUSE = fixtureId('a', ENTITY.org);
const PAYSTACK_ORG = fixtureId('b', ENTITY.org);
const STRIPE_ORG = fixtureId('c', ENTITY.org);
const AUTH_HOUSE = fixtureId('a', ENTITY.authUser);
const AUTH_PAYSTACK = fixtureId('b', ENTITY.authUser);
const AUTH_STRIPE = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);

let db: PGlite;
let app: FastifyInstance;
let bare: FastifyInstance;
const paystack = createFakePaystack();
const stripe = createFakeStripe();

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
const checkout = (who: string, plan: string, currency: string, server = () => app) =>
  server().inject({
    method: 'POST',
    url: '/v1/billing/checkout',
    headers: as(who),
    payload: { plan, currency },
  });

function paystackHook(event: unknown, signature?: string) {
  const body = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/paystack',
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': signature ?? paystack.sign(body),
    },
    payload: body,
  });
}

function stripeHook(event: unknown, at = clock) {
  const body = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripe.sign(body, Math.floor(at.getTime() / 1000)),
    },
    payload: body,
  });
}

async function subscriptionOf(orgId: string) {
  const { rows } = await db.query<{
    plan: string;
    status: string;
    provider: string;
    currency: string;
    external_ref: string | null;
    external_customer: string | null;
    grace_until: Date | null;
  }>(
    `select plan, status, provider, currency::text as currency, external_ref, external_customer, grace_until
       from subscriptions where org_id = $1`,
    [orgId],
  );
  return rows[0] ?? null;
}

async function eventTypes(orgId: string) {
  const { rows } = await db.query<{ type: string }>(
    `select type from events where org_id = $1 and type like 'billing.%' order by created_at, id`,
    [orgId],
  );
  return rows.map((r) => r.type);
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const tag of ['a', 'b', 'c']) for (const row of identityRows(tag)) await db.exec(row.sql);
  for (const row of tenantRows(HOUSE, 'a', 'a')) await db.exec(row.sql);
  for (const [org, tag] of [
    [PAYSTACK_ORG, 'b'],
    [STRIPE_ORG, 'c'],
  ] as const) {
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${org}', '${fixtureId(tag, ENTITY.user)}', 'owner')`);
    await db.exec(`update orgs set billing_exempt = false where id = '${org}'`);
  }
  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${fixtureId('d', ENTITY.user)}', '${AUTH_OPERATOR}', 'd@example.test')`);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${PAYSTACK_ORG}', '${fixtureId('d', ENTITY.user)}', 'operator')`);
  await db.exec(`insert into plans (code, name, limits, prices) values
    ('test-plan', 'Test plan', '{"jobs_scored": 100, "bids_drafted": 100, "bids_submitted": null}',
     '{"ZAR": {"amountMinor": 49900, "paystackPlanCode": "PLN_test"},
       "USD": {"amountMinor": 2900, "stripePriceId": "price_test"}}'),
    ('rand-only', 'Rand only', '{"jobs_scored": 1, "bids_drafted": 1, "bids_submitted": 1}',
     '{"ZAR": {"amountMinor": 10000, "paystackPlanCode": "PLN_rand"}}')`);
  await db.exec('update billing_settings set grace_days = 7');

  const config = billingConfig({
    APP_URL: 'http://localhost:5173',
    PAYSTACK_SECRET_KEY: paystack.secretKey,
    STRIPE_SECRET_KEY: stripe.secretKey,
    STRIPE_WEBHOOK_SECRET: stripe.webhookSecret,
    PAYSTACK_BASE_URL: paystack.origin,
    STRIPE_BASE_URL: stripe.origin,
  });
  const authenticate = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({
    db,
    authenticate,
    now: () => clock,
    billing: { config, paystackFetch: paystack.fetch, stripeFetch: stripe.fetch },
  });
  bare = buildServer({ db, authenticate, now: () => clock });
  await app.ready();
  await bare.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await bare.close();
  await db.close();
});

describe('GET /v1/billing', () => {
  it('lists the plans on sale with a price per currency and who takes it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: as(AUTH_PAYSTACK),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.plans).toEqual([
      {
        code: 'rand-only',
        name: 'Rand only',
        limits: { jobs_scored: 1, bids_drafted: 1, bids_submitted: 1 },
        prices: [{ currency: 'ZAR', provider: 'paystack', amountMinor: 10000 }],
      },
      {
        code: 'test-plan',
        name: 'Test plan',
        limits: { jobs_scored: 100, bids_drafted: 100, bids_submitted: null },
        prices: [
          { currency: 'ZAR', provider: 'paystack', amountMinor: 49900 },
          { currency: 'USD', provider: 'stripe', amountMinor: 2900 },
        ],
      },
    ]);
    expect(body).toMatchObject({
      houseOrg: false,
      subscription: null,
      graceDays: 7,
      state: { kind: 'none', reason: 'no_subscription' },
      providers: {
        paystack: { configured: true, environment: 'stand-in' },
        stripe: { configured: true, environment: 'stand-in' },
      },
    });
  });

  it('says why a provider is off without its keys (B-15)', async () => {
    const body = (
      await bare.inject({ method: 'GET', url: '/v1/billing', headers: as(AUTH_PAYSTACK) })
    ).json();
    expect(body.providers.paystack).toMatchObject({ configured: false });
    expect(body.providers.paystack.reason).toMatch(/B-15/);
  });
});

describe('checkout refusals', () => {
  it.each([
    ['an operator', AUTH_OPERATOR, 'test-plan', 'ZAR', 403, /Only an owner/],
    ['the house org', AUTH_HOUSE, 'test-plan', 'ZAR', 409, /house organisation/],
    [
      'a plan not sold in dollars',
      AUTH_PAYSTACK,
      'rand-only',
      'USD',
      422,
      /not sold in US dollars/,
    ],
    ['a plan not on sale', AUTH_PAYSTACK, 'nope', 'ZAR', 422, /not on sale/],
  ])('refuses %s', async (_label, who, plan, currency, status, error) => {
    const response = await checkout(who, plan, currency);
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatch(error);
  });

  it('refuses without the provider s keys, naming B-15', async () => {
    const response = await checkout(AUTH_PAYSTACK, 'test-plan', 'ZAR', () => bare);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/B-15/);
  });
});

describe('Paystack, in rand', () => {
  let reference = '';
  let subscriptionCode = '';

  it('checkout: an owner is sent to Paystack with the plan code, the amount in cents and our reference', async () => {
    const response = await checkout(AUTH_PAYSTACK, 'test-plan', 'ZAR');
    expect(response.statusCode).toBe(201);
    reference = response.json().reference;
    expect(reference).toMatch(/^arb-[0-9a-f-]{36}$/);
    expect(response.json()).toMatchObject({
      provider: 'paystack',
      url: `${paystack.origin}/checkout/${reference}`,
    });
    expect(paystack.initialized.at(-1)).toMatchObject({
      email: 'b@example.test',
      amount: '49900',
      currency: 'ZAR',
      plan: 'PLN_test',
      reference,
      callback_url: `http://localhost:5173/billing.html?checkout=${reference}`,
    });
    // Nothing is active until Paystack says the payment went through.
    expect(await subscriptionOf(PAYSTACK_ORG)).toBeNull();
  });

  it('refuses a webhook whose signature does not match, and changes nothing', async () => {
    const paid = paystack.pay(reference);
    subscriptionCode = paid.subscriptionCode;
    const forged = await paystackHook(paid.event, 'f'.repeat(128));
    expect(forged.statusCode).toBe(401);
    expect(await subscriptionOf(PAYSTACK_ORG)).toBeNull();
  });

  it('the payment activates the plan, confirmed with Paystack, once however often it arrives', async () => {
    const event = { event: 'charge.success', data: { reference, status: 'success' } };
    const first = await paystackHook(event);
    expect(first.json()).toMatchObject({ received: true, duplicate: false, outcome: 'ok' });
    expect(await subscriptionOf(PAYSTACK_ORG)).toMatchObject({
      plan: 'test-plan',
      status: 'active',
      provider: 'paystack',
      currency: 'ZAR',
      grace_until: null,
    });
    const again = await paystackHook(event);
    expect(again.json()).toMatchObject({ received: true, duplicate: true });
    // Events written in one transaction share its timestamp, so their order is not asserted.
    expect((await eventTypes(PAYSTACK_ORG)).sort()).toEqual([
      'billing.checkout_started',
      'billing.plan_activated',
      'billing.webhook_received',
    ]);
    expect(
      await planUsage(db, { orgId: PAYSTACK_ORG, metric: 'jobs_scored', now: clock }),
    ).toMatchObject({
      ok: true,
      limit: 100,
    });
    // A second checkout while the plan runs would bill twice (D-070).
    expect((await checkout(AUTH_PAYSTACK, 'test-plan', 'ZAR')).statusCode).toBe(409);
  });

  it('a failed renewal starts the grace period; the plan holds until it ends', async () => {
    const failed = await paystackHook(paystack.failRenewal(subscriptionCode));
    expect(failed.json()).toMatchObject({ outcome: 'ok', detail: 'payment_failed' });
    const sub = await subscriptionOf(PAYSTACK_ORG);
    expect(sub).toMatchObject({ status: 'past_due', external_ref: subscriptionCode });
    expect(new Date(sub!.grace_until!).toISOString()).toBe('2026-10-01T08:00:00.000Z');

    clock = new Date('2026-10-01T07:59:00Z');
    expect((await loadOrgPlan(db, PAYSTACK_ORG, clock))?.orgPlan.kind).toBe('plan');
  });

  it('after the grace period the plan no longer holds, and the daily sweep records the downgrade', async () => {
    clock = new Date('2026-10-01T08:00:00Z');
    expect((await loadOrgPlan(db, PAYSTACK_ORG, clock))?.orgPlan).toEqual({
      kind: 'none',
      reason: 'grace_ended',
    });
    const refused = await planUsage(db, { orgId: PAYSTACK_ORG, metric: 'jobs_scored', now: clock });
    expect(refused).toMatchObject({ ok: false, reason: 'no_plan' });
    expect(await downgradeExpired(db, clock)).toEqual([{ orgId: PAYSTACK_ORG, plan: 'test-plan' }]);
    expect(await subscriptionOf(PAYSTACK_ORG)).toMatchObject({
      status: 'cancelled',
      grace_until: null,
    });
    expect((await eventTypes(PAYSTACK_ORG)).slice(-1)).toEqual(['billing.downgraded']);
  });

  it('paying what is owed brings the plan back', async () => {
    const paid = await paystackHook(paystack.payRenewal(subscriptionCode));
    expect(paid.json()).toMatchObject({ outcome: 'ok', detail: 'paid' });
    expect(await subscriptionOf(PAYSTACK_ORG)).toMatchObject({
      status: 'active',
      grace_until: null,
    });
  });

  it('acknowledges, and records as skipped, an event that is not ours', async () => {
    const other = await paystackHook({ event: 'transfer.success', data: { reference: 'x' } });
    expect(other.json()).toMatchObject({ received: true, outcome: 'skipped' });
  });
});

describe('Stripe, in US dollars', () => {
  let sessionId = '';
  let subscriptionId = '';
  let reference = '';

  it('checkout: an owner is sent to Stripe Checkout in subscription mode with the plan s Price', async () => {
    const response = await checkout(AUTH_STRIPE, 'test-plan', 'USD');
    expect(response.statusCode).toBe(201);
    reference = response.json().reference;
    const form = Object.fromEntries(stripe.created.at(-1)!);
    expect(form).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_test',
      'line_items[0][quantity]': '1',
      client_reference_id: reference,
      customer_email: 'c@example.test',
      success_url: `http://localhost:5173/billing.html?checkout=${reference}`,
      cancel_url: 'http://localhost:5173/billing.html?checkout=cancelled',
    });
    sessionId = [...stripe.sessions.keys()].at(-1)!;
    expect(response.json().url).toBe(`${stripe.origin}/pay/${sessionId}`);
  });

  it('refuses a signature older than five minutes', async () => {
    const event = stripe.complete(sessionId);
    subscriptionId = (event.data.object as { subscription: string }).subscription;
    const stale = await stripeHook(event, new Date(clock.getTime() - 301_000));
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toMatch(/too_old/);
    expect(await subscriptionOf(STRIPE_ORG)).toBeNull();
    // The same event, signed now, is accepted.
    const fresh = await stripeHook(event);
    expect(fresh.json()).toMatchObject({ outcome: 'ok' });
    expect(await subscriptionOf(STRIPE_ORG)).toMatchObject({
      plan: 'test-plan',
      status: 'active',
      provider: 'stripe',
      currency: 'USD',
      external_ref: subscriptionId,
    });
  });

  it('past_due starts the grace period; canceled ends the plan at once', async () => {
    await stripeHook(stripe.subscriptionUpdated(subscriptionId, 'past_due'));
    const sub = await subscriptionOf(STRIPE_ORG);
    expect(sub?.status).toBe('past_due');
    expect(new Date(sub!.grace_until!).getTime()).toBe(clock.getTime() + 7 * 86_400_000);
    await stripeHook(stripe.subscriptionDeleted(subscriptionId));
    expect(await subscriptionOf(STRIPE_ORG)).toMatchObject({ status: 'cancelled' });
    expect(await eventTypes(STRIPE_ORG)).toEqual(
      expect.arrayContaining(['billing.payment_failed', 'billing.cancelled']),
    );
  });

  it('refuses a webhook when Stripe is not configured, so Stripe sends it again later', async () => {
    const response = await bare.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(503);
  });
});
