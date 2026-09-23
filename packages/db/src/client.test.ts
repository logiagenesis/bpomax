import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Queryable } from './client.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase } from './testing.js';

/**
 * `withUser` under concurrency: two requests at once must each run as their own user.
 * Before this, both ran their transaction on the one connection they were handed, so the
 * second request's claims could replace the first's mid-way (seen with two concurrent API
 * requests on PGlite, which let a viewer and another org through).
 */
let db: PGlite;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const JOB_A = fixtureId('a', ENTITY.job);
const JOB_B = fixtureId('b', ENTITY.job);

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

/** What a request sees, read in several statements so that two requests can interleave. */
async function whatISee(tx: Queryable) {
  const claims = await tx.query<{ sub: string }>(
    `select current_setting('request.jwt.claims', true)::jsonb ->> 'sub' as sub`,
  );
  await tx.query('select 1');
  const jobs = await tx.query<{ id: string }>('select id from jobs order by id');
  return { sub: claims.rows[0]?.sub, jobs: jobs.rows.map((r) => r.id) };
}

/** Twenty requests from two organisations, all at once. */
async function crowd(target: Queryable) {
  const who = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? AUTH_A : AUTH_B));
  const seen = await Promise.all(who.map((auth) => withUser(target, auth, whatISee)));
  return who.map((auth, i) => ({ auth, ...seen[i]! }));
}

function expectEachOwn(results: Awaited<ReturnType<typeof crowd>>) {
  for (const r of results) {
    expect(r.sub).toBe(r.auth);
    expect(r.jobs).toEqual([r.auth === AUTH_A ? JOB_A : JOB_B]);
  }
}

describe('withUser at the same time', () => {
  it('on PGlite, each request runs as its own user and sees only its own org', async () => {
    expectEachOwn(await crowd(db));
  });

  it('on one plain connection, the transactions take turns', async () => {
    // Only `query`: the shape of a single node-postgres Client.
    const plain: Queryable = { query: (sql, params) => db.query(sql, params) };
    expectEachOwn(await crowd(plain));
    // A failed transaction is rolled back and does not hold up the next.
    await expect(
      withUser(plain, AUTH_A, async (tx) => {
        await tx.query('select 1');
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect((await withUser(plain, AUTH_B, whatISee)).sub).toBe(AUTH_B);
  });

  it('on a pool, the whole transaction runs on one borrowed connection, which is always handed back', async () => {
    const statements: { client: number; sql: string }[] = [];
    let lent = 0;
    let returned = 0;
    // Every borrowed client reaches the same PGlite and the calls here come one after
    // another, so what the test checks is which statements went to which client.
    const plain: Queryable = { query: (sql, params) => db.query(sql, params) };
    const pool: Queryable = {
      query: () => Promise.reject(new Error('a pool query outside a borrowed connection')),
      connect: () => {
        const client = ++lent;
        return Promise.resolve({
          query: <T>(sql: string, params?: unknown[]) => {
            statements.push({ client, sql });
            return plain.query<T>(sql, params);
          },
          release: () => {
            returned += 1;
          },
        });
      },
    };
    const seen = await withUser(pool, AUTH_A, whatISee);
    expect(seen.sub).toBe(AUTH_A);
    expect(new Set(statements.map((s) => s.client))).toEqual(new Set([1]));
    expect(statements.map((s) => s.sql.split(/\s/)[0])).toEqual([
      'begin',
      'select',
      'set',
      'select',
      'select',
      'select',
      'commit',
    ]);
    await expect(withUser(pool, AUTH_B, () => Promise.reject(new Error('no')))).rejects.toThrow(
      'no',
    );
    expect(statements.at(-1)).toEqual({ client: 2, sql: 'rollback' });
    expect({ lent, returned }).toEqual({ lent: 2, returned: 2 });
  });
});
