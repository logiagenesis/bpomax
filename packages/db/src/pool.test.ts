import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, withUser } from './client.js';
import { createPool, type DatabasePool } from './pool.js';

/**
 * ARB-510 (the owner's audit E-01): the production pool against a real Postgres. Every
 * other test runs on PGlite, so the pool must answer in PGlite's shapes; these tests
 * hold the two side by side. CI runs a Postgres service for them; locally it is the
 * compose Postgres on 54322 (README).
 */
const URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let pool: DatabasePool;
let lite: PGlite;

beforeAll(async () => {
  pool = createPool({ connectionString: URL, max: 4, applicationName: 'arbitron-pool-test' });
  lite = new PGlite();
  await pool.query('drop schema if exists pool_test cascade');
  await pool.query('create schema pool_test');
  await pool.query('create table pool_test.t (id int primary key, n int8 not null)');
  await pool.query(`do $$ begin create role authenticated nologin;
    exception when duplicate_object then null; end $$`);
  await pool.query('grant usage on schema pool_test to authenticated');
  await pool.query('grant select on pool_test.t to authenticated');
}, 60_000);

afterAll(async () => {
  await pool.query('drop schema if exists pool_test cascade');
  await pool.end();
  await lite.close();
});

/** A value as JSON, with the class of any object, so a Date and its string differ. */
function shape(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `Date:${value.toISOString()}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

describe('values come back as PGlite gives them', () => {
  const expressions = [
    ['bigint', `9007199254740991::int8`],
    ['bigint array', `array[1, 2, null]::int8[]`],
    ['integer', `2::int4`],
    ['smallint', `3::int2`],
    ['numeric', `1234.50::numeric(12, 2)`],
    ['double', `1.5::float8`],
    ['boolean', `true`],
    ['text', `'R1 234,56'::text`],
    ['uuid', `'3f2b6c1e-0000-4000-8000-000000000001'::uuid`],
    ['timestamptz', `'2026-09-26 12:34:56.789+02'::timestamptz`],
    ['timestamp', `'2026-09-26 12:34:56'::timestamp`],
    ['date', `'2026-02-28'::date`],
    ['jsonb', `'{"a": 1, "b": [true, null]}'::jsonb`],
    ['json', `'{"a": 1}'::json`],
    ['text array', `array['a', 'b']::text[]`],
    ['null', `null::int8`],
    ['bytea', `'\\x6869'::bytea`],
    ['time', `'12:00'::time`],
    ['interval', `'1 day'::interval`],
  ] as const;

  it.each(expressions)('%s', async (_name, expression) => {
    const sql = `select ${expression} as v`;
    const fromPool = await pool.query<{ v: unknown }>(sql);
    const fromLite = await lite.query<{ v: unknown }>(sql);
    expect(shape(fromPool.rows[0]?.v)).toBe(shape(fromLite.rows[0]?.v));
  });
});

describe('the Queryable contract', () => {
  it('reports affected rows as PGlite does', async () => {
    const inserted = await pool.query('insert into pool_test.t values (1, 10), (2, 20)');
    expect(inserted.affectedRows).toBe(2);
    const updated = await pool.query('update pool_test.t set n = n + 1 where id = $1', [1]);
    expect(updated.affectedRows).toBe(1);
    const none = await pool.query('update pool_test.t set n = 0 where id = $1', [99]);
    expect(none.affectedRows).toBe(0);
  });

  it('commits a transaction on its own borrowed connection, and rolls back a failed one', async () => {
    await inTransaction(pool, async (tx) => {
      await tx.query('insert into pool_test.t values (3, 30)');
    });
    await expect(
      inTransaction(pool, async (tx) => {
        await tx.query('insert into pool_test.t values (4, 40)');
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    const { rows } = await pool.query<{ id: number }>(
      'select id from pool_test.t where id in (3, 4) order by id',
    );
    expect(rows).toEqual([{ id: 3 }]);
  });

  it('runs concurrent transactions each on its own connection', async () => {
    const pids = await Promise.all(
      [0, 1, 2].map(() =>
        inTransaction(pool, async (tx) => {
          const { rows } = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          await tx.query('select pg_sleep(0.05)');
          return rows[0]!.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(3);
  });

  it('keeps a signed-in role to its own transaction, never leaking to the next borrower', async () => {
    const inside = await withUser(pool, '3f2b6c1e-0000-4000-8000-000000000001', async (tx) => {
      const { rows } = await tx.query<{ role: string; sub: string }>(
        `select current_user as role, current_setting('request.jwt.claims', true)::jsonb->>'sub' as sub`,
      );
      return rows[0];
    });
    expect(inside).toEqual({ role: 'authenticated', sub: '3f2b6c1e-0000-4000-8000-000000000001' });
    const after = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        const { rows } = await pool.query<{ role: string; claims: string | null }>(
          `select current_user as role, nullif(current_setting('request.jwt.claims', true), '') as claims`,
        );
        return rows[0];
      }),
    );
    for (const row of after) expect(row).toEqual({ role: 'postgres', claims: null });
  });
});
