import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from './client.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { recordLlmCall, summariseSpend } from './llm-calls.js';
import { createTestDatabase } from './testing.js';

/** ARB-031: cost recorded per call, and scoped to the org like everything else. */
let db: PGlite;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('metering a call', () => {
  it('stores the tokens, the cost and how many attempts it took', async () => {
    const id = await recordLlmCall(db, {
      orgId: ORG_A,
      purpose: 'score',
      model: 'claude-opus-5',
      subjectTable: 'jobs',
      subjectId: fixtureId('a', ENTITY.job),
      inputTokens: 2_000,
      outputTokens: 1_000,
      costNanoUsd: 35_000_000,
      attempts: 2,
      outcome: 'ok',
      problems: [['/score must be integer']],
    });

    const { rows } = await db.query<{
      cost_nano_usd: string;
      attempts: number;
      outcome: string;
      problems: unknown;
    }>('select cost_nano_usd::text, attempts, outcome, problems from llm_calls where id = $1', [
      id,
    ]);

    expect(Number(rows[0]?.cost_nano_usd)).toBe(35_000_000);
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.outcome).toBe('ok');
    expect(rows[0]?.problems).toEqual([['/score must be integer']]);
  });

  it('records a call that never produced usable output', async () => {
    const id = await recordLlmCall(db, {
      orgId: ORG_A,
      purpose: 'draft',
      model: 'claude-opus-5',
      inputTokens: 2_000,
      outputTokens: 1_000,
      costNanoUsd: 35_000_000,
      attempts: 2,
      outcome: 'invalid_output',
    });
    const { rows } = await db.query<{ outcome: string }>(
      'select outcome from llm_calls where id = $1',
      [id],
    );
    // A call that failed still cost money; leaving it out would understate the bill.
    expect(rows[0]?.outcome).toBe('invalid_output');
  });

  it('refuses a negative cost', async () => {
    await expect(
      recordLlmCall(db, {
        orgId: ORG_A,
        purpose: 'other',
        model: 'claude-opus-5',
        costNanoUsd: -1,
      }),
    ).rejects.toThrow(/cost_nano_usd/);
  });

  it('refuses a purpose nobody defined', async () => {
    await expect(
      recordLlmCall(db, {
        orgId: ORG_A,
        // @ts-expect-error — the enum is the point of the test.
        purpose: 'vibes',
        model: 'claude-opus-5',
      }),
    ).rejects.toThrow(/llm_purpose/);
  });
});

describe('what has been spent', () => {
  it('adds up by purpose and model, for your org only', async () => {
    await recordLlmCall(db, {
      orgId: ORG_B,
      purpose: 'score',
      model: 'claude-opus-5',
      costNanoUsd: 999_000_000,
    });

    const mine = await withUser(db, AUTH_A, (tx) => summariseSpend(tx));
    const scoring = mine.find((row) => row.purpose === 'score');
    expect(scoring?.costNanoUsd).toBe(35_000_000 + 10_000_000); // this test's call plus the fixture row
    expect(mine.every((row) => row.costNanoUsd < 999_000_000)).toBe(true);

    const theirs = await withUser(db, AUTH_B, (tx) => summariseSpend(tx));
    expect(theirs.find((row) => row.purpose === 'score')?.costNanoUsd).toBe(
      999_000_000 + 10_000_000,
    );
  });

  it('tells the caller when a write was refused instead of reporting success', async () => {
    await expect(
      withUser(db, AUTH_B, (tx) =>
        recordLlmCall(tx, { orgId: ORG_A, purpose: 'score', model: 'claude-opus-5' }),
      ),
    ).rejects.toThrow(/row-level security|was not metered/i);
  });
});
