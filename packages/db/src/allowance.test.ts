import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bidUsage,
  releaseBid,
  releaseScannerSlot,
  reserveBid,
  reserveScannerSlot,
} from './allowance.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-042 acceptance: "Submission blocked with clear message when allowance reached".
 * The allowance figures are this file's test data (docs/02 T-03 is open).
 */
const ORG = fixtureId('a', ENTITY.org);
const NOW = new Date('2026-09-22T12:00:00Z');
let db: PGlite;

async function setAllowance(allowance: number | null, planName: string | null = 'Test plan') {
  await db.query(
    `update platform_accounts set plan_name = $2, monthly_bid_allowance = $3, plan_recorded_on = $4
     where org_id = $1 and platform = 'freelancer'`,
    [ORG, planName, allowance, allowance === null ? null : '2026-09-22'],
  );
}

async function counter(periodStart = '2026-09-01') {
  const { rows } = await db.query<{ used: number; limit_value: number | null }>(
    `select used, limit_value from usage_counters
     where org_id = $1 and metric = 'bids:freelancer' and period_start = $2`,
    [ORG, periodStart],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('before the owner records the plan (T-03)', () => {
  it('refuses to reserve a bid, says why, and leaves the counter untouched', async () => {
    const verdict = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(verdict).toMatchObject({ ok: false, reason: 'allowance_unknown', used: 0, limit: null });
    if (verdict.ok) return;
    expect(verdict.message).toMatch(/T-03/);
    expect(await counter()).toBeNull();
  });

  it('refuses a platform with no account', async () => {
    const verdict = await reserveBid(db, { orgId: ORG, platform: 'upwork', now: NOW });
    expect(verdict).toMatchObject({ ok: false, reason: 'no_account' });
  });
});

describe('with a recorded allowance', () => {
  it('counts each bid, then blocks at the limit with a clear message', async () => {
    await setAllowance(2);
    const first = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(first).toEqual({
      ok: true,
      used: 1,
      limit: 2,
      remaining: 1,
      period: { start: '2026-09-01', resetsOn: '2026-10-01' },
    });
    const second = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(second).toMatchObject({ ok: true, used: 2, remaining: 0 });

    const third = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(third).toMatchObject({ ok: false, reason: 'allowance_reached', used: 2, limit: 2 });
    if (third.ok) return;
    expect(third.message).toBe(
      'The freelancer bid allowance is used up: 2 of 2 bids this period on the Test plan plan. It resets on 01/10/2026.',
    );
    // The refused reservation did not move the counter.
    expect(await counter()).toEqual({ used: 2, limit_value: 2 });
  });

  it('reports the standing without taking a bid', async () => {
    const usage = await bidUsage(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(usage).toMatchObject({ ok: false, reason: 'allowance_reached', used: 2, limit: 2 });
    expect(await counter()).toEqual({ used: 2, limit_value: 2 });
  });

  it('gives back a bid that was never placed, and never goes below zero', async () => {
    expect(await releaseBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toBe(1);
    const again = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(again).toMatchObject({ ok: true, used: 2, remaining: 0 });

    await releaseBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    await releaseBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(await releaseBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toBe(0);
    expect(await counter()).toEqual({ used: 0, limit_value: 2 });
  });

  it('starts a fresh count in the next period', async () => {
    await setAllowance(1);
    expect(await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toMatchObject({
      ok: true,
      used: 1,
    });
    expect(await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toMatchObject({
      ok: false,
      reason: 'allowance_reached',
    });
    const october = new Date('2026-10-03T08:00:00Z');
    const fresh = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: october });
    expect(fresh).toMatchObject({
      ok: true,
      used: 1,
      period: { start: '2026-10-01', resetsOn: '2026-11-01' },
    });
    expect(await counter('2026-10-01')).toEqual({ used: 1, limit_value: 1 });
  });

  it('follows the allowance when the owner changes it, without losing the count', async () => {
    // September stands at 1 of 1. Raising the plan to 3 admits two more.
    await setAllowance(3, 'Bigger plan');
    expect(await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toMatchObject({
      ok: true,
      used: 2,
      limit: 3,
    });
    expect(await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toMatchObject({
      ok: true,
      used: 3,
      limit: 3,
    });
    const over = await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW });
    expect(over).toMatchObject({ ok: false, reason: 'allowance_reached', used: 3, limit: 3 });
    if (!over.ok) expect(over.message).toMatch(/on the Bigger plan plan/);
    // Lowering it below what is used blocks at once, and keeps the count as it was.
    await setAllowance(2);
    expect(await reserveBid(db, { orgId: ORG, platform: 'freelancer', now: NOW })).toMatchObject({
      ok: false,
      used: 3,
      limit: 2,
    });
    expect(await counter()).toEqual({ used: 3, limit_value: 3 });
  });

  it('treats an allowance of zero as nothing to give', async () => {
    await setAllowance(0);
    const verdict = await reserveBid(db, {
      orgId: ORG,
      platform: 'freelancer',
      now: new Date('2026-11-05T08:00:00Z'),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'allowance_reached', used: 0, limit: 0 });
    expect(await counter('2026-11-01')).toBeNull();
  });
});

describe('a scanner s daily auto-send cap (ARB-044)', () => {
  const SCANNER = fixtureId('a', ENTITY.scanner);
  const MIDDAY = new Date('2026-09-22T12:00:00Z');

  it('admits bids up to the cap for the day, then refuses with a message', async () => {
    const first = await reserveScannerSlot(db, {
      orgId: ORG,
      scannerId: SCANNER,
      dailyCap: 2,
      now: MIDDAY,
    });
    expect(first).toEqual({ ok: true, used: 1, cap: 2, day: '2026-09-22' });
    expect(
      await reserveScannerSlot(db, { orgId: ORG, scannerId: SCANNER, dailyCap: 2, now: MIDDAY }),
    ).toMatchObject({ ok: true, used: 2 });
    const third = await reserveScannerSlot(db, {
      orgId: ORG,
      scannerId: SCANNER,
      dailyCap: 2,
      now: MIDDAY,
    });
    expect(third).toMatchObject({ ok: false, used: 2, cap: 2 });
    if (!third.ok)
      expect(third.message).toBe(
        "The scanner's daily auto-send cap is reached: 2 of 2 today. It resets at midnight, South African time.",
      );
  });

  it('gives a slot back, and starts afresh the next South African day', async () => {
    expect(await releaseScannerSlot(db, { orgId: ORG, scannerId: SCANNER, now: MIDDAY })).toBe(1);
    expect(
      await reserveScannerSlot(db, { orgId: ORG, scannerId: SCANNER, dailyCap: 2, now: MIDDAY }),
    ).toMatchObject({ ok: true, used: 2 });
    // 22:30 UTC on the 22nd is already the 23rd in Johannesburg.
    const tomorrow = new Date('2026-09-22T22:30:00Z');
    expect(
      await reserveScannerSlot(db, { orgId: ORG, scannerId: SCANNER, dailyCap: 2, now: tomorrow }),
    ).toEqual({
      ok: true,
      used: 1,
      cap: 2,
      day: '2026-09-23',
    });
  });

  it('admits nothing on a cap of zero, and leaves no counter behind', async () => {
    const other = new Date('2026-10-01T08:00:00Z');
    expect(
      await reserveScannerSlot(db, { orgId: ORG, scannerId: SCANNER, dailyCap: 0, now: other }),
    ).toMatchObject({ ok: false, used: 0, cap: 0 });
    const { rows } = await db.query(
      `select 1 from usage_counters where org_id = $1 and metric = $2 and period_start = '2026-10-01'`,
      [ORG, `auto_send:${SCANNER}`],
    );
    expect(rows).toHaveLength(0);
  });
});
