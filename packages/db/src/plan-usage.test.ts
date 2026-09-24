import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { loadOrgPlan, planUsage, releasePlanUsage, reservePlanUsage } from './plan-usage.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-410: an org's plan, its monthly counters and the conditional take. The plan here
 * is test data with a made-up name and limits; no real plan exists (docs/02 D-12).
 */
const HOUSE = fixtureId('a', ENTITY.org);
const CUSTOMER = fixtureId('b', ENTITY.org);
const AUTH_CUSTOMER = fixtureId('b', ENTITY.authUser);
const NOW = new Date('2026-09-24T08:00:00Z');
const OCTOBER = new Date('2026-10-02T08:00:00Z');
let db: PGlite;

const reserve = (metric: 'jobs_scored' | 'bids_drafted' | 'bids_submitted', orgId = CUSTOMER) =>
  reservePlanUsage(db, { orgId, metric, now: NOW });

async function counter(metric: string, orgId = CUSTOMER) {
  const { rows } = await db.query<{ used: number; limit_value: number | null }>(
    `select used, limit_value from usage_counters where org_id = $1 and metric = $2`,
    [orgId, `plan:${metric}`],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(HOUSE, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(CUSTOMER, 'b', 'b')) await db.exec(row.sql);
  // b is a customer who signed up (ARB-400): not the house org. Its fixture subscription
  // names the plan code 'starter', which does not exist until a test publishes it.
  await db.exec(`update orgs set billing_exempt = false where id = '${CUSTOMER}'`);
  await db.exec(`update subscriptions set status = 'active' where org_id = '${CUSTOMER}'`);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('the house org', () => {
  it('is counted but never limited', async () => {
    for (let i = 0; i < 3; i += 1) {
      const taken = await reserve('jobs_scored', HOUSE);
      expect(taken.verdict).toMatchObject({ ok: true, limit: null });
      expect(taken.crossed).toEqual([]);
    }
    expect(await counter('jobs_scored', HOUSE)).toEqual({ used: 3, limit_value: null });
    expect((await loadOrgPlan(db, HOUSE))?.orgPlan).toEqual({ kind: 'exempt' });
  });
});

describe('before any plan is published (D-12)', () => {
  it('refuses a customer every metered action, names D-12, and counts nothing', async () => {
    const taken = await reserve('jobs_scored');
    expect(taken.verdict).toMatchObject({ ok: false, reason: 'no_plan' });
    if (!taken.verdict.ok) expect(taken.verdict.message).toMatch(/D-12/);
    expect(await counter('jobs_scored')).toBeNull();
  });
});

describe('on a plan', () => {
  beforeAll(async () => {
    await db.exec(`insert into plans (code, name, limits) values
      ('starter', 'Test plan', '{"jobs_scored": 5, "bids_drafted": 0, "bids_submitted": null}')`);
  });

  it('takes each action up to the limit, crossing 80 % at 4 and 100 % at 5', async () => {
    const crossings = [];
    for (let i = 1; i <= 5; i += 1) {
      const taken = await reserve('jobs_scored');
      expect(taken.verdict).toMatchObject({ ok: true, used: i, limit: 5 });
      expect(taken.planName).toBe('Test plan');
      crossings.push(taken.crossed);
    }
    expect(crossings).toEqual([[], [], [], [80], [100]]);
  });

  it('refuses the next one with the message, and leaves the counter at the limit', async () => {
    const taken = await reserve('jobs_scored');
    expect(taken.verdict).toMatchObject({ ok: false, reason: 'limit_reached', used: 5, limit: 5 });
    if (!taken.verdict.ok) {
      expect(taken.verdict.message).toBe(
        "The Test plan plan's monthly limit for scoring jobs is reached: 5 of 5 used. It resets on 01/10/2026. Choose a bigger plan in Settings to go on now.",
      );
    }
    expect(taken.crossed).toEqual([]);
    expect(await counter('jobs_scored')).toEqual({ used: 5, limit_value: 5 });
    expect(await planUsage(db, { orgId: CUSTOMER, metric: 'jobs_scored', now: NOW })).toMatchObject(
      { ok: false, reason: 'limit_reached' },
    );
  });

  it('refuses a metric the plan does not include, and counts one it leaves open', async () => {
    expect((await reserve('bids_drafted')).verdict).toMatchObject({
      ok: false,
      reason: 'not_included',
    });
    for (let i = 0; i < 7; i += 1) {
      expect((await reserve('bids_submitted')).verdict).toMatchObject({ ok: true, limit: null });
    }
    expect(await counter('bids_submitted')).toEqual({ used: 7, limit_value: null });
  });

  it('gives an action back, never below zero, and the freed one can be taken again', async () => {
    expect(await releasePlanUsage(db, { orgId: CUSTOMER, metric: 'jobs_scored', now: NOW })).toBe(
      4,
    );
    const again = await reserve('jobs_scored');
    // 4 → 5 is the 100 % crossing again: a give-back re-arms it.
    expect(again).toMatchObject({ verdict: { ok: true, used: 5 }, crossed: [100] });
    await db.exec(
      `update usage_counters set used = 0 where org_id = '${CUSTOMER}' and metric = 'plan:bids_drafted'`,
    );
    expect(await releasePlanUsage(db, { orgId: CUSTOMER, metric: 'bids_drafted', now: NOW })).toBe(
      0,
    );
  });

  it('starts every month afresh', async () => {
    const taken = await reservePlanUsage(db, {
      orgId: CUSTOMER,
      metric: 'jobs_scored',
      now: OCTOBER,
    });
    expect(taken.verdict).toMatchObject({ ok: true, used: 1 });
  });

  it('holds the limit when many actions arrive at once', async () => {
    await db.exec(
      `update plans set limits = '{"jobs_scored": 5, "bids_drafted": 10, "bids_submitted": null}'`,
    );
    const results = await Promise.all(Array.from({ length: 25 }, () => reserve('bids_drafted')));
    expect(results.filter((r) => r.verdict.ok)).toHaveLength(10);
    expect(results.flatMap((r) => r.crossed).sort()).toEqual([100, 80]);
    expect(await counter('bids_drafted')).toEqual({ used: 10, limit_value: 10 });
  });

  it('ends the plan once a failed payment s grace period is over (ARB-420)', async () => {
    await db.exec(`update subscriptions set status = 'past_due', grace_until = '2026-09-30T08:00:00Z'
                   where org_id = '${CUSTOMER}'`);
    const before = await loadOrgPlan(db, CUSTOMER, new Date('2026-09-30T07:59:00Z'));
    expect(before?.orgPlan).toMatchObject({ kind: 'plan', status: 'past_due' });
    const after = await loadOrgPlan(db, CUSTOMER, new Date('2026-09-30T08:00:00Z'));
    expect(after?.orgPlan).toEqual({ kind: 'none', reason: 'grace_ended' });
    await db.exec(
      `update subscriptions set status = 'active', grace_until = null where org_id = '${CUSTOMER}'`,
    );
  });

  it.each([
    [
      'cancelled',
      `update subscriptions set status = 'cancelled' where org_id = '${CUSTOMER}'`,
      'cancelled',
    ],
    [
      'unknown',
      `update subscriptions set status = 'active', plan = 'gone' where org_id = '${CUSTOMER}'`,
      'unknown_plan',
    ],
    ['absent', `delete from subscriptions where org_id = '${CUSTOMER}'`, 'no_subscription'],
  ])('refuses when the subscription is %s', async (_label, sql, reason) => {
    await db.exec(sql);
    expect((await loadOrgPlan(db, CUSTOMER))?.orgPlan).toEqual({ kind: 'none', reason });
    expect((await reserve('bids_submitted')).verdict).toMatchObject({
      ok: false,
      reason: 'no_plan',
    });
  });
});

describe('who may write the counters and the plan (RLS)', () => {
  it('lets a member read the plan and their counters', async () => {
    await signIn(db, AUTH_CUSTOMER);
    const plans = await db.query('select code from plans');
    expect(plans.rows.length).toBeGreaterThan(0);
    const counters = await db.query('select 1 from usage_counters where org_id = $1', [CUSTOMER]);
    expect(counters.rows.length).toBeGreaterThan(0);
    await signOut(db);
  });

  it('refuses an owner any write to counters, subscriptions or plans', async () => {
    await signIn(db, AUTH_CUSTOMER);
    const wound = await db.query(`update usage_counters set used = 0 where org_id = $1`, [
      CUSTOMER,
    ]);
    expect(wound.affectedRows).toBe(0);
    await expect(
      db.exec(
        `insert into subscriptions (org_id, plan, status) values ('${CUSTOMER}', 'starter', 'active')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(db.exec(`update plans set limits = '{}'`)).rejects.toThrow(/permission denied/);
    await signOut(db);
  });

  it('lets an owner rename their org but not exempt it from billing', async () => {
    await signIn(db, AUTH_CUSTOMER);
    const renamed = await db.query(`update orgs set name = 'Renamed' where id = $1`, [CUSTOMER]);
    expect(renamed.affectedRows).toBe(1);
    await expect(
      db.exec(`update orgs set billing_exempt = true where id = '${CUSTOMER}'`),
    ).rejects.toThrow(/permission denied/);
    await signOut(db);
    const { rows } = await db.query<{ billing_exempt: boolean }>(
      'select billing_exempt from orgs where id = $1',
      [CUSTOMER],
    );
    expect(rows[0]?.billing_exempt).toBe(false);
  });

  it('makes a new org through sign-up a customer, not the house org', async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'late@example.test')`, [
      fixtureId('f', ENTITY.authUser),
    ]);
    await signIn(db, fixtureId('f', ENTITY.authUser));
    const { rows } = await db.query<{ id: string }>(`select app.create_org('Late Co') as id`);
    await signOut(db);
    expect((await loadOrgPlan(db, rows[0]!.id))?.orgPlan.kind).toBe('none');
  });
});
