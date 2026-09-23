import { insertBriefVersion, listEvents, lockBrief } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-310 acceptance: "Milestone totals reconcile to agreed cost". Real Postgres (PGlite)
 * with RLS on; the figures are hand-worked beside each assertion and are test data.
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
let requestId: string;
let thandi: string;
let noQuote: string;
let itemId: string;
let orderId: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

const BRIEF = {
  title: 'Shopify store rebuild',
  outcome: 'A faster shop',
  users: null,
  mustHaves: ['Checkout', 'Stock sync'],
  later: [],
  references: [],
  assetsProvided: ['Logo files'],
  assetsMissing: [],
  techConstraints: ['Shopify'],
  deadline: '2026-10-30',
  deadlineFixed: true,
  budget: { minMinor: 1000000, maxMinor: 2000000, currency: 'ZAR', type: 'fixed' as const },
  acceptanceCriteria: ['Orders go through'],
  signOff: { name: null, responseTime: null },
  risks: [],
  category: 'wordpress',
  deliveryRoute: 'supplier' as const,
};

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
  await db.query(
    `insert into service_categories (slug, name, sort_order) values ('wordpress', 'WordPress', 2) on conflict (slug) do nothing`,
  );
  const job = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, budget_max_minor, currency)
     values ($1, 'freelancer', '15791512', '{}'::jsonb, 'Shopify store rebuild', 1500000, 'ZAR') returning id`,
    [ORG_A],
  );
  const item = await db.query<{ id: string }>(
    `insert into pipeline_items (org_id, job_id, stage, value_minor, currency)
     values ($1, $2, 'applied', 1500000, 'ZAR') returning id`,
    [ORG_A, job.rows[0]!.id],
  );
  itemId = item.rows[0]!.id;
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle)
     values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG_A, job.rows[0]!.id],
  );
  const brief = await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: t.rows[0]!.id,
    brief: BRIEF,
  });
  const locked = await lockBrief(db, brief, NOW);
  if (!locked.ok) throw new Error('fixture brief should lock');
  const r = await db.query<{ id: string }>(
    `insert into sourcing_requests (org_id, brief_id, status) values ($1, $2, 'shortlisting') returning id`,
    [ORG_A, locked.brief.id],
  );
  requestId = r.rows[0]!.id;
  const s = await db.query<{ id: string }>(
    `insert into suppliers (org_id, name, channel) values ($1, 'Thandi Web', 'direct') returning id`,
    [ORG_A],
  );
  const c1 = await db.query<{ id: string }>(
    `insert into supplier_candidates (org_id, sourcing_request_id, supplier_id, display_name, quoted_price_minor, currency, turnaround_days)
     values ($1, $2, $3, 'Thandi Web', 900050, 'ZAR', 5) returning id`,
    [ORG_A, requestId, s.rows[0]!.id],
  );
  thandi = c1.rows[0]!.id;
  const c2 = await db.query<{ id: string }>(
    `insert into supplier_candidates (org_id, sourcing_request_id, external_profile_url, display_name)
     values ($1, $2, 'https://example.test/x', 'No Quote') returning id`,
    [ORG_A, requestId],
  );
  noQuote = c2.rows[0]!.id;

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => NOW,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

const choose = (candidate: string, who = AUTH_A) =>
  app.inject({
    method: 'POST',
    url: `/v1/sourcing-requests/${requestId}/candidates/${candidate}/choose`,
    headers: as(who),
  });
const move = (status: string, who = AUTH_A) =>
  app.inject({
    method: 'POST',
    url: `/v1/delivery-orders/${orderId}/status`,
    headers: as(who),
    payload: { status },
  });

describe('choosing a supplier', () => {
  it('refuses a viewer and a candidate with no quote, with the reason', async () => {
    expect((await choose(thandi, AUTH_VIEWER)).statusCode).toBe(403);
    const none = await choose(noQuote);
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe(
      'This candidate has no quote yet, so there is no cost to agree. Ask for one first.',
    );
  });

  it('opens a draft order at the quote, one milestone holding all of it, and the brief’s handover checklist', async () => {
    const res = await choose(thandi);
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    orderId = order.id;
    expect(order).toMatchObject({
      status: 'draft',
      supplierName: 'Thandi Web',
      jobTitle: 'Shopify store rebuild',
      briefTitle: 'Shopify store rebuild',
      pipelineStage: 'applied',
      agreedCostMinor: '900050',
      currency: 'ZAR',
      due: '2026-10-30',
      milestonesTotalMinor: '900050',
      reconciled: true,
      milestones: [
        { title: 'Full delivery', amountMinor: 900050, due: '2026-10-30', status: 'pending' },
      ],
    });
    expect(order.handover.map((i: { key: string }) => i.key)).toEqual([
      'scope',
      'acceptance-1',
      'constraint-1',
      'asset-1',
      'deadline',
      'milestones',
    ]);
    expect(JSON.stringify(order.handover)).not.toContain('acme-shop');
    expect(order.moves.assigned).toEqual([
      'The job is not won yet (its stage is applied), so no supplier is assigned.',
    ]);
    const request = await db.query<{ status: string }>(
      'select status::text as status from sourcing_requests where id = $1',
      [requestId],
    );
    expect(request.rows[0]?.status).toBe('chosen');
    expect((await listEvents(db, { type: 'delivery.order_created' }))[0]).toMatchObject({
      subject_id: orderId,
    });
    // One live order per job, and the request is no longer open for choosing.
    expect((await choose(thandi)).statusCode).toBe(409);
  });
});

describe('milestones reconcile to the agreed cost', () => {
  it('saves a split that adds up, and refuses one that does not, in money words', async () => {
    // R3 000,00 + R6 000,50 = R9 000,50: reconciles.
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/delivery-orders/${orderId}`,
      headers: as(AUTH_A),
      payload: {
        agreedCostMinor: 900050,
        currency: 'ZAR',
        due: '2026-10-30',
        milestones: [
          { title: 'Design', amountMinor: 300000, due: '2026-10-09' },
          { title: 'Build', amountMinor: 600050, due: '2026-10-30' },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().order).toMatchObject({ milestonesTotalMinor: '900050', reconciled: true });

    // R3 000,00 + R6 000,00 = R9 000,00 against R9 000,50: refused, nothing saved.
    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/delivery-orders/${orderId}`,
      headers: as(AUTH_A),
      payload: {
        agreedCostMinor: 900050,
        currency: 'ZAR',
        milestones: [
          { title: 'Design', amountMinor: 300000 },
          { title: 'Build', amountMinor: 600000 },
        ],
      },
    });
    expect(off.statusCode).toBe(422);
    expect(off.json().errors).toEqual([
      {
        field: 'milestones',
        message: expect.stringMatching(/add up to R9.000,00; the agreed cost is R9.000,50/),
      },
    ]);
    const viewer = await app.inject({
      method: 'PATCH',
      url: `/v1/delivery-orders/${orderId}`,
      headers: as(AUTH_VIEWER),
      payload: {
        agreedCostMinor: 900050,
        currency: 'ZAR',
        milestones: [{ title: 'All', amountMinor: 900050 }],
      },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('the database refuses an assigned order whose milestones stop adding up', async () => {
    // Win the job, then assign.
    const won = await app.inject({
      method: 'PATCH',
      url: `/v1/pipeline-items/${itemId}`,
      headers: as(AUTH_A),
      payload: { stage: 'won' },
    });
    expect(won.statusCode).toBe(200);
    expect((await listEvents(db, { type: 'pipeline.stage_changed' }))[0]?.payload).toMatchObject({
      from: 'applied',
      to: 'won',
    });
    const assigned = await move('assigned');
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().order.status).toBe('assigned');
    await expect(
      db.query(
        `update delivery_orders set milestones = '[{"title":"All","amountMinor":1,"due":null,"status":"pending"}]'::jsonb where id = $1`,
        [orderId],
      ),
    ).rejects.toThrow(/milestones_reconcile/);
  });
});

describe('moving the order', () => {
  it('starts only once every handover item is ticked; the job moves to in delivery', async () => {
    const early = await move('in_progress');
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe(
      '6 handover items are not ticked yet; the supplier starts once the handover is complete.',
    );
    for (const key of [
      'scope',
      'acceptance-1',
      'constraint-1',
      'asset-1',
      'deadline',
      'milestones',
    ]) {
      const tick = await app.inject({
        method: 'PATCH',
        url: `/v1/delivery-orders/${orderId}/handover/${key}`,
        headers: as(AUTH_A),
        payload: { done: true },
      });
      expect(tick.statusCode).toBe(200);
    }
    const started = await move('in_progress');
    expect(started.statusCode).toBe(200);
    expect(started.json().order).toMatchObject({
      status: 'in_progress',
      pipelineStage: 'in_delivery',
    });
    expect(started.json().order.handedOverAt).not.toBeNull();
    const late = await app.inject({
      method: 'PATCH',
      url: `/v1/delivery-orders/${orderId}/handover/scope`,
      headers: as(AUTH_A),
      payload: { done: false },
    });
    expect(late.statusCode).toBe(409);
  });

  it('is delivered once every milestone is, and accepted once every milestone is', async () => {
    expect((await move('delivered')).json().error).toBe('2 milestones are not delivered yet.');
    const mark = (index: number, status: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/delivery-orders/${orderId}/milestones/${String(index)}`,
        headers: as(AUTH_A),
        payload: { status },
      });
    expect((await mark(0, 'delivered')).statusCode).toBe(200);
    expect((await mark(1, 'delivered')).statusCode).toBe(200);
    const delivered = await move('delivered');
    expect(delivered.json().order).toMatchObject({
      status: 'delivered',
      pipelineStage: 'delivered',
    });
    expect((await move('accepted')).json().error).toBe('2 milestones are not accepted yet.');
    expect((await mark(0, 'accepted')).statusCode).toBe(200);
    expect((await mark(0, 'pending')).statusCode).toBe(409);
    expect((await mark(1, 'accepted')).statusCode).toBe(200);
    const accepted = await move('accepted');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().order.status).toBe('accepted');
    expect((await move('cancelled')).json().error).toBe(
      'An accepted order cannot be moved to cancelled.',
    );
    expect(await listEvents(db, { type: 'delivery.status_changed' })).toHaveLength(4);
  });
});

describe('the pipeline board and the lists', () => {
  it('shows the organisation’s items with their live order, and nothing to another', async () => {
    const board = await app.inject({
      method: 'GET',
      url: '/v1/pipeline',
      headers: as(AUTH_VIEWER),
    });
    expect(board.json().stages[0]).toBe('applied');
    expect(board.json().items).toEqual([
      expect.objectContaining({
        id: itemId,
        stage: 'delivered',
        valueMinor: '1500000',
        deliveryOrderId: orderId,
        deliveryStatus: 'accepted',
      }),
    ]);
    const other = await app.inject({ method: 'GET', url: '/v1/pipeline', headers: as(AUTH_B) });
    expect(other.json().items).toEqual([]);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/delivery-orders?status=accepted',
      headers: as(AUTH_A),
    });
    expect(list.json().orders.map((o: { id: string }) => o.id)).toEqual([orderId]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/delivery-orders/${orderId}`,
          headers: as(AUTH_B),
        })
      ).statusCode,
    ).toBe(404);
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/pipeline-items/${itemId}`,
      headers: as(AUTH_A),
      payload: { stage: 'finished' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('a cancelled order reopens its request, so another supplier can be chosen', async () => {
    // A second job, won, with an order that is cancelled before work starts.
    const job = await db.query<{ id: string }>(
      `insert into jobs (org_id, platform, external_id, raw, title) values ($1, 'freelancer', '2', '{}'::jsonb, 'Second') returning id`,
      [ORG_A],
    );
    await db.query(`update threads set job_id = $2 where org_id = $1`, [ORG_A, job.rows[0]!.id]);
    await db.query(`insert into pipeline_items (org_id, job_id, stage) values ($1, $2, 'won')`, [
      ORG_A,
      job.rows[0]!.id,
    ]);
    await db.query(`update sourcing_requests set status = 'shortlisting' where id = $1`, [
      requestId,
    ]);
    const second = await choose(thandi);
    expect(second.statusCode).toBe(201);
    orderId = second.json().order.id;
    expect((await move('cancelled')).json().order.status).toBe('cancelled');
    const request = await db.query<{ status: string }>(
      'select status::text as status from sourcing_requests where id = $1',
      [requestId],
    );
    expect(request.rows[0]?.status).toBe('shortlisting');
    expect((await choose(thandi)).statusCode).toBe(201);
  });
});
