import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { loadMigrations } from './migrations.js';
import { SUPABASE_SHIM_SQL } from './testing.js';

/**
 * ARB-520, the owner's audit P-06: migration 0037 makes a marketplace thread unique per
 * org, moves any message filed in another org's thread to its own org's thread, and
 * refuses such a message from then on. The database is built to 0036, a stray is filed
 * the way the old inbox sync filed one, and then 0037 runs.
 */
let db: PGlite;
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const THREAD_A = fixtureId('a', ENTITY.thread);
let stray: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_SHIM_SQL);
  const migrations = loadMigrations();
  const last = migrations.findIndex((m) => m.name.startsWith('0037_'));
  expect(last).toBeGreaterThan(0);
  for (const migration of migrations.slice(0, last)) await db.exec(migration.sql);
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);

  // What the old sync did for org B in org A's thread.
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'out', 'Org B''s view of the thread', '2026-09-23T08:01:00Z', 'ext-b-1', 'platform')
     returning id`,
    [ORG_B, THREAD_A],
  );
  stray = rows[0]!.id;
  for (const migration of migrations.slice(last)) await db.exec(migration.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('0037: a thread per org', () => {
  it("moves a message filed in another org's thread to a thread of its own org", async () => {
    const { rows } = await db.query<{ org_id: string; thread_org: string; external: string }>(
      `select m.org_id, t.org_id as thread_org, t.external_thread_id as external
         from messages m join threads t on t.id = m.thread_id where m.id = $1`,
      [stray],
    );
    const a = await db.query<{ external_thread_id: string }>(
      'select external_thread_id from threads where id = $1',
      [THREAD_A],
    );
    expect(rows[0]).toEqual({
      org_id: ORG_B,
      thread_org: ORG_B,
      external: a.rows[0]!.external_thread_id,
    });
    const strays = await db.query<{ count: number }>(
      `select count(*)::int as count from messages m join threads t on t.id = m.thread_id
        where m.org_id <> t.org_id`,
    );
    expect(strays.rows[0]?.count).toBe(0);
  });

  it('lets two orgs hold the same marketplace thread, and one org only once', async () => {
    await db.query(
      `insert into threads (org_id, platform, external_thread_id) values ($1, 'freelancer', 'shared-1'), ($2, 'freelancer', 'shared-1')`,
      [ORG_A, ORG_B],
    );
    await expect(
      db.query(
        `insert into threads (org_id, platform, external_thread_id) values ($1, 'freelancer', 'shared-1')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/threads_org_platform_external_thread_key/);
  });

  it("refuses a message filed in another org's thread, however it is written", async () => {
    await expect(
      db.query(
        `insert into messages (org_id, thread_id, direction, body) values ($1, $2, 'in', 'stray')`,
        [ORG_B, THREAD_A],
      ),
    ).rejects.toThrow(/a message must belong to a thread of its own org/);
    const own = await db.query<{ id: string }>(
      `insert into messages (org_id, thread_id, direction, body) values ($1, $2, 'in', 'fine') returning id`,
      [ORG_A, THREAD_A],
    );
    await expect(
      db.query('update messages set org_id = $2 where id = $1', [own.rows[0]!.id, ORG_B]),
    ).rejects.toThrow(/its own org/);
  });
});
