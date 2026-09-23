import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-312 acceptance: "Dashboard retainer total equals sum of active retainers". Real
 * Postgres (PGlite) with RLS on: retainers set through the pipeline route, then the
 * dashboard's total compared with a hand sum and with a raw SQL sum.
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
const items: Record<string, string> = {};

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

async function item(org: string, title: string, stage: string, currency: string | null) {
  const job = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title) values ($1, 'freelancer', $2, '{}'::jsonb, $2) returning id`,
    [org, title],
  );
  const row = await db.query<{ id: string }>(
    `insert into pipeline_items (org_id, job_id, stage, currency) values ($1, $2, $3::pipeline_stage, $4) returning id`,
    [org, job.rows[0]!.id, stage, currency],
  );
  return row.rows[0]!.id;
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
  items.care = await item(ORG_A, 'Monthly site care', 'paid', 'ZAR');
  items.seo = await item(ORG_A, 'SEO retainer', 'in_delivery', 'ZAR');
  items.lost = await item(ORG_A, 'Lost retainer', 'lost', 'ZAR');
  items.usd = await item(ORG_A, 'Dollar support', 'won', 'USD');
  items.noCurrency = await item(ORG_A, 'No currency yet', 'won', null);
  items.other = await item(ORG_B, 'Another org', 'won', 'ZAR');
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

const setRetainer = (id: string, body: Record<string, unknown>, who = AUTH_A) =>
  app.inject({ method: 'PATCH', url: `/v1/pipeline-items/${id}`, headers: as(who), payload: body });

describe('the retainer toggle', () => {
  it('sets a retainer with its monthly amount, logged; refuses one without an amount, and a viewer', async () => {
    const res = await setRetainer(items.care!, { retainer: true, retainerMonthlyMinor: 450_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stage: 'paid',
      retainer: true,
      retainerMonthlyMinor: '450000',
      currency: 'ZAR',
    });
    expect((await listEvents(db, { type: 'pipeline.retainer_changed' }))[0]?.payload).toMatchObject(
      {
        from: { retainer: false, monthly_minor: null },
        to: { retainer: true, monthly_minor: '450000' },
      },
    );
    const noAmount = await setRetainer(items.seo!, { retainer: true });
    expect(noAmount.statusCode).toBe(422);
    expect(noAmount.json().errors[0].field).toBe('retainerMonthlyMinor');
    const viewer = await setRetainer(
      items.seo!,
      { retainer: true, retainerMonthlyMinor: 300_000 },
      AUTH_VIEWER,
    );
    expect(viewer.statusCode).toBe(403);
    // A job with no currency needs the retainer's currency with it.
    const bare = await setRetainer(items.noCurrency!, {
      retainer: true,
      retainerMonthlyMinor: 100_000,
    });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().errors[0].field).toBe('currency');
    const withCurrency = await setRetainer(items.noCurrency!, {
      retainer: true,
      retainerMonthlyMinor: 100_000,
      currency: 'zar',
    });
    expect(withCurrency.json()).toMatchObject({ currency: 'ZAR', retainerMonthlyMinor: '100000' });
    // Another organisation's item is not found.
    expect(
      (await setRetainer(items.other!, { retainer: true, retainerMonthlyMinor: 1 })).statusCode,
    ).toBe(404);
  });

  it('the dashboard’s retainer total equals the sum of active retainers, by hand and by SQL', async () => {
    await setRetainer(items.seo!, { retainer: true, retainerMonthlyMinor: 300_000 });
    await setRetainer(items.lost!, { retainer: true, retainerMonthlyMinor: 200_000 });
    await setRetainer(items.usd!, { retainer: true, retainerMonthlyMinor: 50_000 });
    // Turned off again: no longer counted.
    await setRetainer(items.noCurrency!, { retainer: false });
    // Active: R4 500,00 + R3 000,00 = R7 500,00 (the lost one's R2 000,00 left out);
    // USD 500,00 kept apart, never converted.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: as(AUTH_A),
    });
    expect(dashboard.json().retainers).toEqual([
      { currency: 'USD', amountMinor: '50000', count: 1 },
      { currency: 'ZAR', amountMinor: '750000', count: 2 },
    ]);
    const raw = await db.query<{ currency: string; total: string }>(
      `select currency::text as currency, sum(retainer_monthly_minor)::text as total
         from pipeline_items where org_id = $1 and retainer and stage <> 'lost'
        group by currency order by currency`,
      [ORG_A],
    );
    expect(raw.rows).toEqual([
      { currency: 'USD', total: '50000' },
      { currency: 'ZAR', total: '750000' },
    ]);
    const cleared = await db.query<{ retainer: boolean; retainer_monthly_minor: string | null }>(
      `select retainer, retainer_monthly_minor::text from pipeline_items where id = $1`,
      [items.noCurrency],
    );
    expect(cleared.rows[0]).toEqual({ retainer: false, retainer_monthly_minor: null });
    // The other organisation's dashboard sees none of them.
    const other = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: as(AUTH_B) });
    expect(other.json().retainers).toEqual([]);
  });

  it('a stage and a retainer can be sent together; an empty change is refused', async () => {
    const both = await setRetainer(items.usd!, {
      stage: 'in_delivery',
      retainer: true,
      retainerMonthlyMinor: 60_000,
    });
    expect(both.json()).toMatchObject({ stage: 'in_delivery', retainerMonthlyMinor: '60000' });
    expect((await setRetainer(items.usd!, {})).statusCode).toBe(422);
  });
});
