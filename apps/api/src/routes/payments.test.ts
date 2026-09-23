import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-311 acceptance: "Realised margin matches hand calculation in tests". Real Postgres
 * (PGlite) with RLS on. The payments, rates and fees are test data, hand-worked beside
 * each assertion; B-10 (the FX provider) is a scripted stand-in where one is used.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let app: FastifyInstance;
let withFx: FastifyInstance;
let itemId: string;
let usdItem: string;
let orderId: string;
let draftOrderId: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
const authenticate = (request: { headers: Record<string, unknown> }) => {
  const header = request.headers['x-test-auth-user'];
  return typeof header === 'string' ? header : null;
};

async function jobAndItem(title: string, value: number, currency: string, stage = 'delivered') {
  const job = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title) values ($1, 'freelancer', $2, '{}'::jsonb, $2) returning id`,
    [ORG_A, title],
  );
  const item = await db.query<{ id: string }>(
    `insert into pipeline_items (org_id, job_id, stage, value_minor, currency) values ($1, $2, $3::pipeline_stage, $4, $5) returning id`,
    [ORG_A, job.rows[0]!.id, stage, value, currency],
  );
  return item.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  await db.exec(
    `insert into users (id, auth_user_id, email) values ('${fixtureId('c', ENTITY.user)}', '${AUTH_VIEWER}', 'c@example.test')`,
  );
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${fixtureId('c', ENTITY.user)}', 'viewer')`,
  );
  // A R15 000,00 job, delivered by a South African supplier against R9 000,50.
  itemId = await jobAndItem('Shopify store rebuild', 1_500_000, 'ZAR');
  const supplier = await db.query<{ id: string }>(
    `insert into suppliers (org_id, name, channel, country_code) values ($1, 'Thandi Web', 'direct', 'ZA') returning id`,
    [ORG_A],
  );
  const milestones = JSON.stringify([
    { title: 'Design', amountMinor: 300_000, due: null, status: 'accepted' },
    { title: 'Build', amountMinor: 600_050, due: null, status: 'accepted' },
  ]);
  const o = await db.query<{ id: string }>(
    `insert into delivery_orders (org_id, pipeline_item_id, supplier_id, status, agreed_cost_minor, currency, milestones)
     values ($1, $2, $3, 'accepted', 900050, 'ZAR', $4::jsonb) returning id`,
    [ORG_A, itemId, supplier.rows[0]!.id, milestones],
  );
  orderId = o.rows[0]!.id;
  // A USD job whose supplier is a bidder abroad, still in draft.
  usdItem = await jobAndItem('Dashboard in USD', 60_000, 'USD', 'won');
  const d = await db.query<{ id: string }>(
    `insert into delivery_orders (org_id, pipeline_item_id, status, agreed_cost_minor, currency, milestones)
     values ($1, $2, 'draft', 30000, 'USD', '[{"title":"All","amountMinor":30000,"due":null,"status":"pending"}]'::jsonb) returning id`,
    [ORG_A, usdItem],
  );
  draftOrderId = d.rows[0]!.id;

  app = buildServer({ db, authenticate, now: () => NOW });
  await app.ready();
  withFx = buildServer({
    db,
    authenticate,
    now: () => NOW,
    fx: {
      quote: (from, to) =>
        Promise.resolve({
          rate: '18.25',
          from,
          to,
          at: '2026-09-23T09:00:00.000Z',
          source: 'scripted',
        }),
    },
  });
  await withFx.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await withFx.close();
  await db.close();
});

const pay = (body: Record<string, unknown>, item = itemId, who = AUTH_A, server = app) =>
  server.inject({
    method: 'POST',
    url: `/v1/pipeline-items/${item}/payments`,
    headers: as(who),
    payload: body,
  });

describe('recording payments', () => {
  it('refuses a viewer, a day not yet come, and a supplier payment against another job’s order', async () => {
    const client = { kind: 'client', amountMinor: 750_000, currency: 'ZAR', paidOn: '2026-09-20' };
    expect((await pay(client, itemId, AUTH_VIEWER)).statusCode).toBe(403);
    const future = await pay({ ...client, paidOn: '2026-09-24' });
    expect(future.statusCode).toBe(422);
    expect(future.json().errors[0].field).toBe('paidOn');
    const elsewhere = await pay(
      {
        kind: 'supplier',
        amountMinor: 1,
        currency: 'USD',
        fxRate: '18',
        paidOn: '2026-09-20',
        deliveryOrderId: orderId,
      },
      usdItem,
    );
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().errors[0]).toMatchObject({ field: 'deliveryOrderId' });
  });

  it('records the job’s payments and works realised margin as the hand calculation', async () => {
    // In: R7 500,00 + R7 500,00. Supplier: R3 000,00 (Design) + R6 000,50 (Build).
    // Fee: R1 500,00. Margin: R15 000,00 − R9 000,50 − R1 500,00 = R4 499,50.
    const payments = [
      {
        kind: 'client',
        amountMinor: 750_000,
        currency: 'ZAR',
        paidOn: '2026-09-18',
        reference: 'FL-1',
      },
      {
        kind: 'supplier',
        amountMinor: 300_000,
        currency: 'ZAR',
        paidOn: '2026-09-19',
        deliveryOrderId: orderId,
        milestoneIndex: 0,
      },
      {
        kind: 'supplier',
        amountMinor: 600_050,
        currency: 'ZAR',
        paidOn: '2026-09-21',
        deliveryOrderId: orderId,
        milestoneIndex: 1,
      },
      { kind: 'platform_fee', amountMinor: 150_000, currency: 'ZAR', paidOn: '2026-09-22' },
    ];
    for (const body of payments) {
      const res = await pay(body);
      expect(res.statusCode).toBe(201);
      // A South African supplier: no T-05 notice.
      expect(res.json().notice).toBeNull();
    }
    const last = await pay({
      kind: 'client',
      amountMinor: 750_000,
      currency: 'ZAR',
      paidOn: '2026-09-23',
    });
    expect(last.statusCode).toBe(201);
    expect(last.json().margin).toEqual({
      inZarMinor: '1500000',
      supplierZarMinor: '900050',
      feesZarMinor: '150000',
      otherZarMinor: '0',
      marginZarMinor: '449950',
      unconverted: [],
    });
    // Paid in full: the job moves to Paid, and says so in the audit log.
    expect(last.json().paidInFull).toBe(true);
    expect(last.json().item.stage).toBe('paid');
    expect((await listEvents(db, { type: 'pipeline.stage_changed' }))[0]?.payload).toMatchObject({
      from: 'delivered',
      to: 'paid',
      via: 'payments',
    });
    expect(await listEvents(db, { type: 'payment.recorded' })).toHaveLength(5);
    const view = await app.inject({
      method: 'GET',
      url: `/v1/pipeline-items/${itemId}/payments`,
      headers: as(AUTH_VIEWER),
    });
    expect(
      view.json().payments.map((p: { milestoneIndex: number | null }) => p.milestoneIndex),
    ).toEqual([null, 0, 1, null, null]);
    expect(view.json().payments[0]).toMatchObject({
      reference: 'FL-1',
      paidAt: '2026-09-17T22:00:00.000Z',
    });
  });

  it('a payment not in rand needs its rate: typed, or the FX provider’s; with neither it is refused', async () => {
    const noRate = await pay(
      { kind: 'client', amountMinor: 50_000, currency: 'USD', paidOn: '2026-09-22' },
      usdItem,
    );
    expect(noRate.statusCode).toBe(422);
    expect(noRate.json().errors[0]).toMatchObject({
      field: 'fxRate',
      message: expect.stringMatching(/no FX provider is configured \(docs\/02 B-10\)/),
    });
    // Typed: USD 500,00 at 18.25 = R9 125,00, the rate dated the day it was paid.
    const typed = await pay(
      {
        kind: 'client',
        amountMinor: 50_000,
        currency: 'USD',
        paidOn: '2026-09-22',
        fxRate: '18.25',
      },
      usdItem,
    );
    expect(typed.json().payments[0]).toMatchObject({
      amountZarMinor: '912500',
      fxRateUsed: '18.25000000',
      fxRateAt: '2026-09-21T22:00:00.000Z',
    });
    // From the provider: USD 50,00 fee at its 18.25 = R912,50, dated when it answered.
    const fromProvider = await pay(
      { kind: 'platform_fee', amountMinor: 5_000, currency: 'USD', paidOn: '2026-09-23' },
      usdItem,
      AUTH_A,
      withFx,
    );
    expect(fromProvider.json().payments[1]).toMatchObject({
      amountZarMinor: '91250',
      fxRateAt: '2026-09-23T09:00:00.000Z',
    });
    // R9 125,00 − R912,50 = R8 212,50; USD 500,00 of USD 600,00 paid: not in full.
    expect(fromProvider.json().margin.marginZarMinor).toBe('821250');
    expect(fromProvider.json().paidInFull).toBe(false);
    // The database keeps the rate beside every converted figure (0005).
    await expect(
      db.query(
        `insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, amount_zar_minor)
         values ($1, $2, 'in', 'client', 1, 'USD', 18)`,
        [ORG_A, usdItem],
      ),
    ).rejects.toThrow(/converted_amount_shows_its_rate/);
  });

  it('a supplier is paid once assigned; one abroad carries the T-05 notice', async () => {
    const early = await pay(
      {
        kind: 'supplier',
        amountMinor: 30_000,
        currency: 'USD',
        fxRate: '18.25',
        paidOn: '2026-09-23',
        deliveryOrderId: draftOrderId,
      },
      usdItem,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('A supplier is paid once assigned. Assign the supplier first.');
    await db.query(`update delivery_orders set status = 'assigned' where id = $1`, [draftOrderId]);
    const abroad = await pay(
      {
        kind: 'supplier',
        amountMinor: 30_000,
        currency: 'USD',
        fxRate: '18.25',
        paidOn: '2026-09-23',
        deliveryOrderId: draftOrderId,
        milestoneIndex: 0,
      },
      usdItem,
    );
    expect(abroad.statusCode).toBe(201);
    expect(abroad.json().notice).toMatch(/^docs\/02 T-05 is open/);
    // USD 300,00 at 18.25 = R5 475,00; margin R8 212,50 − R5 475,00 = R2 737,50.
    expect(abroad.json().margin.marginZarMinor).toBe('273750');
    const bad = await pay(
      {
        kind: 'supplier',
        amountMinor: 1,
        currency: 'USD',
        fxRate: '18',
        paidOn: '2026-09-23',
        deliveryOrderId: draftOrderId,
        milestoneIndex: 3,
      },
      usdItem,
    );
    expect(bad.statusCode).toBe(422);
  });

  it('another organisation sees nothing and records nothing', async () => {
    const view = await app.inject({
      method: 'GET',
      url: `/v1/pipeline-items/${itemId}/payments`,
      headers: as(AUTH_B),
    });
    expect(view.statusCode).toBe(404);
    const write = await pay(
      { kind: 'client', amountMinor: 1, currency: 'ZAR', paidOn: '2026-09-23' },
      itemId,
      AUTH_B,
    );
    expect(write.statusCode).toBe(404);
  });
});
