import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBid, editBid, rejectBid } from './approvals.js';
import type { Queryable } from './client.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-512, the owner's audit E-06: one approval module for the web, MCP and Telegram,
 * with conditional changes. "Concurrent approve and reject through both paths: exactly
 * one wins." The two paths are two callers of the module (the API route and the bot both
 * call it, see their tests); a change landing between another's read and write is forced
 * here by running it just before the module's first statement.
 */
let db: PGlite;
const ORG = fixtureId('a', ENTITY.org);
const USER = fixtureId('a', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
const actor = { orgId: ORG, userId: USER };

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function queuedBid(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status)
     values ($1, $2, 'A bid.', 150000, 'ZAR', 7, 'queued') returning id`,
    [ORG, JOB],
  );
  return rows[0]!.id;
}

async function events(id: string): Promise<string[]> {
  const { rows } = await db.query<{ type: string }>(
    `select type from events where subject_id = $1 and type like 'proposal.%' order by created_at`,
    [id],
  );
  return rows.map((r) => r.type);
}

async function status(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    'select status::text as status from proposals where id = $1',
    [id],
  );
  return rows[0]!.status;
}

/** A connection on which `meanwhile` happens just before the first statement runs. */
function racing(meanwhile: () => Promise<unknown>): Queryable {
  let fired = false;
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      if (!fired) {
        fired = true;
        await meanwhile();
      }
      return db.query<T>(sql, params);
    },
  };
}

describe('two people at once', () => {
  it('approve on the page and in Telegram: one approves, the other is told, one event', async () => {
    const id = await queuedBid();
    const results = await Promise.all([
      approveBid(db, actor, id, 'web'),
      approveBid(db, actor, id, 'telegram'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      code: 409,
      message: 'This bid is already approved.',
    });
    expect(await events(id)).toEqual(['proposal.approved']);
    expect(await status(id)).toBe('approved');
  });

  it('an approval that lands first wins over a second one, whichever path it came from', async () => {
    const id = await queuedBid();
    const telegram = await approveBid(
      racing(() => approveBid(db, actor, id, 'web')),
      actor,
      id,
      'telegram',
    );
    expect(telegram).toMatchObject({ ok: false, code: 409 });
    const { rows } = await db.query<{ approved_via: string }>(
      'select approved_via::text as approved_via from proposals where id = $1',
      [id],
    );
    expect(rows[0]?.approved_via).toBe('web');
    expect(await events(id)).toEqual(['proposal.approved']);
  });

  it('a reject cannot overwrite a bid sent in the meantime', async () => {
    const id = await queuedBid();
    await approveBid(db, actor, id, 'web');
    const reject = await rejectBid(
      racing(() => db.query(`update proposals set status = 'submitted' where id = $1`, [id])),
      actor,
      id,
      'Too low',
      'telegram',
    );
    expect(reject).toEqual({ ok: false, code: 409, message: 'This bid has already been sent.' });
    expect(await status(id)).toBe('submitted');
    expect(await events(id)).toEqual(['proposal.approved']);
  });

  it('an edit cannot overwrite a bid sent in the meantime', async () => {
    const id = await queuedBid();
    await approveBid(db, actor, id, 'web');
    const edit = await editBid(
      racing(() => db.query(`update proposals set status = 'submitted' where id = $1`, [id])),
      actor,
      id,
      'New words',
      'telegram',
    );
    expect(edit).toMatchObject({ ok: false, code: 409 });
    const { rows } = await db.query<{ body: string }>('select body from proposals where id = $1', [
      id,
    ]);
    expect(rows[0]?.body).toBe('A bid.');
  });

  it('reject then approve: the approval is refused; approve then reject: the rejection cancels it', async () => {
    const first = await queuedBid();
    expect(await rejectBid(db, actor, first, 'No', 'web')).toMatchObject({ ok: true });
    expect(await approveBid(db, actor, first, 'telegram')).toMatchObject({ ok: false, code: 409 });
    expect(await events(first)).toEqual(['proposal.rejected']);

    const second = await queuedBid();
    expect(await approveBid(db, actor, second, 'telegram')).toMatchObject({ ok: true });
    expect(await rejectBid(db, actor, second, 'Changed my mind', 'web')).toEqual({
      ok: true,
      statusBefore: 'approved',
    });
    expect(await status(second)).toBe('rejected');
    expect(await events(second)).toEqual(['proposal.approved', 'proposal.rejected']);
  });

  it("does not touch another org's bid, and says there is no such bid", async () => {
    const id = await queuedBid();
    const stranger = { orgId: fixtureId('b', ENTITY.org), userId: USER };
    expect(await approveBid(db, stranger, id, 'web')).toMatchObject({ ok: false, code: 404 });
    expect(await rejectBid(db, stranger, id, 'x', 'web')).toMatchObject({ ok: false, code: 404 });
    expect(await editBid(db, stranger, id, 'x', 'web')).toMatchObject({ ok: false, code: 404 });
    expect(await status(id)).toBe('queued');
  });
});
