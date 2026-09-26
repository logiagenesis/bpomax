import { billingConfig } from '@arbitron/billing';
import { createFakePaystack } from '@arbitron/billing/fake';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-430 acceptance: "Referral code tracked from click to paid subscription". Real
 * Postgres with RLS on; the payment goes through the Paystack stand-in exactly as in
 * ARB-420. The affiliate, its 10% commission and the plan are test values (D-071, D-12).
 */
const NOW = new Date('2026-09-24T08:00:00Z');
const HOUSE = fixtureId('a', ENTITY.org);
const AUTH_HOUSE = fixtureId('a', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const AUTH_REFERRED = fixtureId('e', ENTITY.authUser);
const AUTH_LATER = fixtureId('f', ENTITY.authUser);
let db: PGlite;
let app: FastifyInstance;
const paystack = createFakePaystack();

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
const click = (code: string, landingPage = 'index.html') =>
  app.inject({ method: 'POST', url: '/v1/referrals/clicks', payload: { code, landingPage } });
const report = (who = AUTH_HOUSE) =>
  app.inject({ method: 'GET', url: '/v1/affiliates', headers: as(who) });

async function attribution(clickId: string) {
  const { rows } = await db.query<{
    org_id: string | null;
    landing_page: string | null;
    signed_up_at: Date | null;
    converted_at: Date | null;
  }>('select org_id, landing_page, signed_up_at, converted_at from attribution where id = $1', [
    clickId,
  ]);
  return rows[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(HOUSE, 'a', 'a')) await db.exec(row.sql);
  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${fixtureId('d', ENTITY.user)}', '${AUTH_OPERATOR}', 'd@example.test')`);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${HOUSE}', '${fixtureId('d', ENTITY.user)}', 'operator')`);
  for (const [auth, email] of [
    [AUTH_REFERRED, 'referred@example.test'],
    [AUTH_LATER, 'later@example.test'],
  ] as const) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [auth, email]);
  }
  await db.exec(`insert into plans (code, name, limits, prices) values
    ('test-plan', 'Test plan', '{"jobs_scored": 10, "bids_drafted": 10, "bids_submitted": 10}',
     '{"ZAR": {"amountMinor": 49900, "paystackPlanCode": "PLN_test"}}')`);
  app = buildServer({
    db,
    now: () => NOW,
    terms: { version: 'v1', approvedOn: '2026-10-01' },
    authenticate: (request) => {
      const header = (request.headers as Record<string, unknown>)['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    billing: {
      config: billingConfig({
        APP_URL: 'http://localhost:5173',
        PAYSTACK_SECRET_KEY: paystack.secretKey,
        PAYSTACK_BASE_URL: paystack.origin,
      }),
      paystackFetch: paystack.fetch,
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the programme', () => {
  it('only the house org s owner runs it', async () => {
    expect((await report(AUTH_OPERATOR)).statusCode).toBe(403);
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/affiliates',
      headers: as(AUTH_OPERATOR),
      payload: { code: 'sneaky' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe(
      "Only the house organisation's owner runs the affiliate programme.",
    );
  });

  it('the owner adds an affiliate with the commission as agreed, and a code is used once', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/affiliates',
      headers: as(AUTH_HOUSE),
      payload: { code: 'partner-1', ownerEmail: 'partner@example.test', commissionPct: '10' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().affiliate).toMatchObject({
      code: 'partner-1',
      ownerEmail: 'partner@example.test',
      commissionPct: '10.000',
      active: true,
      clicks: 0,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/affiliates',
      headers: as(AUTH_HOUSE),
      payload: { code: 'PARTNER-1' },
    });
    expect(again.statusCode).toBe(409);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/affiliates',
      headers: as(AUTH_HOUSE),
      payload: { code: 'x', commissionPct: '150' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.map((e: { field: string }) => e.field)).toEqual([
      'code',
      'commissionPct',
    ]);
  });
});

describe('from the click to a paid subscription', () => {
  let clickId = '';
  let orgId = '';

  it('a click by the link is recorded with the page, and nothing about the visitor', async () => {
    const response = await click('partner-1', 'index.html');
    expect(response.statusCode).toBe(201);
    clickId = response.json().clickId;
    expect(await attribution(clickId)).toMatchObject({
      org_id: null,
      landing_page: 'index.html',
      signed_up_at: null,
      converted_at: null,
    });
    expect((await click('no-such-code')).statusCode).toBe(404);
    // A second visitor clicks and never signs up.
    expect((await click('partner-1', 'signup.html')).statusCode).toBe(201);
  });

  it('the org created in that browser is attributed to the affiliate', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: as(AUTH_REFERRED),
      payload: { name: 'Referred Co', referral: clickId, termsVersion: 'v1' },
    });
    expect(created.statusCode).toBe(201);
    orgId = created.json().org.id;
    const row = await attribution(clickId);
    expect(row.org_id).toBe(orgId);
    expect(row.signed_up_at).not.toBeNull();
    const { rows } = await db.query<{ type: string }>(
      `select type from events where org_id = $1 and type = 'affiliate.attributed'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
  });

  it('a click already used cannot attach another org', async () => {
    const later = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: as(AUTH_LATER),
      payload: { name: 'Later Co', referral: clickId, termsVersion: 'v1' },
    });
    expect(later.statusCode).toBe(201);
    expect((await attribution(clickId)).org_id).toBe(orgId);
  });

  it('the org s first paid plan converts the referral, once', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: as(AUTH_REFERRED),
      payload: { plan: 'test-plan', currency: 'ZAR' },
    });
    expect(checkout.statusCode).toBe(201);
    const reference = checkout.json().reference as string;
    const paid = paystack.pay(reference);
    const body = JSON.stringify(paid.event);
    const hook = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': paystack.sign(body) },
      payload: body,
    });
    expect(hook.json()).toMatchObject({ outcome: 'ok' });
    expect((await attribution(clickId)).converted_at).not.toBeNull();
    const { rows } = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from events where org_id = $1 and type = 'affiliate.converted'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ plan: 'test-plan' });
  });

  it('the owner s report follows the code from click to paid', async () => {
    const response = await report();
    expect(response.statusCode).toBe(200);
    const partner = (response.json().affiliates as { code: string }[]).find(
      (a) => a.code === 'partner-1',
    );
    expect(partner).toMatchObject({ clicks: 2, signUps: 1, paid: 1 });
  });

  it('switching the affiliate off stops new clicks counting, and keeps what it earned', async () => {
    const partner = () =>
      report().then((r) =>
        (r.json().affiliates as { id: string; code: string }[]).find(
          (a) => a.code === 'partner-1',
        )!,
      );
    const id = (await partner()).id;
    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/affiliates/${id}`,
      headers: as(AUTH_HOUSE),
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await click('partner-1')).statusCode).toBe(404);
    expect(await partner()).toMatchObject({ active: false, paid: 1 });
  });
});
