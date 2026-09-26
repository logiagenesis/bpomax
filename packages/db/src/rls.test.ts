import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CATEGORY_SLUG,
  ENTITY,
  REFERENCE_ROWS,
  TENANT_TABLES,
  fixtureId,
  identityRows,
  tenantRows,
} from './fixtures.js';
import { createTestDatabase, signIn, signInAsNobody, signOut } from './testing.js';

/**
 * ARB-011 acceptance: cross-org read and write is denied on every table.
 *
 * Two orgs are seeded with a row in all thirty tenant-scoped tables. Every assertion
 * below is made while acting as org B's *owner* — the highest role there is — so a pass
 * means no role in another tenant can reach org A's data, not merely that a viewer
 * cannot. The policies run in real Postgres under the real `authenticated` role; a
 * superuser would bypass RLS entirely and prove nothing.
 */
let db: PGlite;

/** Tags are uuid-safe hex. a = org A, b = org B, c = a viewer, d = an operator. */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);

async function run(sql: string): Promise<void> {
  await db.exec(sql);
}

beforeAll(async () => {
  db = await createTestDatabase();

  for (const row of REFERENCE_ROWS) await run(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await run(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await run(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await run(row.sql);

  // Two more people inside org A, to separate "another tenant" from "a lesser role".
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await run(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await run(`insert into memberships (org_id, user_id, role) values
      ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }
});

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

describe('row level security is switched on', () => {
  it('leaves no table in public unprotected', async () => {
    const { rows } = await db.query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by c.relname
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('gives the anon role no access to any table', async () => {
    const { rows } = await db.query<{ count: number }>(`
      select count(*)::int as count from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'
    `);
    expect(rows[0]?.count).toBe(0);
  });
});

describe.each(TENANT_TABLES)('%s', (table) => {
  it("hides the other org's rows and shows your own", async () => {
    await signIn(db, AUTH_B);

    const theirs = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [ORG_A],
    );
    expect(theirs.rows[0]?.count).toBe(0);

    // The mirror assertion matters as much: a policy of `using (false)` would pass the
    // line above while making the product useless.
    const mine = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [ORG_B],
    );
    expect(mine.rows[0]?.count).toBeGreaterThan(0);
  });

  it('refuses an insert into the other org', async () => {
    const row = tenantRows(ORG_A, 'a', 'e').find((candidate) => candidate.table === table);
    expect(row, `no fixture row for ${table}`).toBeDefined();

    await signIn(db, AUTH_B);
    // Refused by row-level security, or before it by a column grant (0038, ARB-502).
    await expect(db.exec(row!.sql)).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('changes nothing in the other org', async () => {
    await signIn(db, AUTH_B);

    // A column the person may not write at all is refused outright (0038): no change either.
    const updated = await db
      .query(`update ${table} set org_id = org_id where org_id = $1`, [ORG_A])
      .catch((error: Error) => {
        if (/permission denied/i.test(error.message)) return { affectedRows: 0 };
        throw error;
      });
    expect(updated.affectedRows).toBe(0);

    const deleted = await db.query(`delete from ${table} where org_id = $1`, [ORG_A]);
    expect(deleted.affectedRows).toBe(0);

    await signOut(db);
    const survivors = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [ORG_A],
    );
    expect(survivors.rows[0]?.count).toBeGreaterThan(0);
  });
});

describe('orgs and users', () => {
  it('shows you your own org and not anyone else s', async () => {
    await signIn(db, AUTH_B);
    const { rows } = await db.query<{ id: string }>('select id from orgs order by id');
    expect(rows.map((r) => r.id)).toEqual([ORG_B]);
  });

  it('shows colleagues but not strangers', async () => {
    await signIn(db, AUTH_A);
    const { rows } = await db.query<{ email: string }>('select email from users order by email');
    // a owns org A; c and d are in it. b is in another tenant entirely.
    expect(rows.map((r) => r.email)).toEqual([
      'a@example.test',
      'c@example.test',
      'd@example.test',
    ]);
  });

  it('refuses to rename another org', async () => {
    await signIn(db, AUTH_B);
    const result = await db.query(`update orgs set name = 'taken' where id = $1`, [ORG_A]);
    expect(result.affectedRows).toBe(0);
  });
});

describe('a session with no user', () => {
  it.each(TENANT_TABLES)('reads nothing from %s', async (table) => {
    await signInAsNobody(db);
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table}`,
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe('roles inside one org', () => {
  it('lets an operator write ordinary records', async () => {
    await signIn(db, AUTH_OPERATOR);
    await expect(
      db.exec(
        `insert into suppliers (org_id, name, channel) values ('${ORG_A}', 'By operator', 'direct')`,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a viewer any write at all', async () => {
    await signIn(db, AUTH_VIEWER);
    await expect(
      db.exec(
        `insert into suppliers (org_id, name, channel) values ('${ORG_A}', 'By viewer', 'direct')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses a viewer an update on an existing record', async () => {
    await signIn(db, AUTH_VIEWER);
    const result = await db.query(`update suppliers set active = false where org_id = $1`, [ORG_A]);
    expect(result.affectedRows).toBe(0);
  });

  it('lets only the owner change settings', async () => {
    await signIn(db, AUTH_OPERATOR);
    const byOperator = await db.query(`update settings set vat_pct = 14 where org_id = $1`, [
      ORG_A,
    ]);
    expect(byOperator.affectedRows).toBe(0);

    await signIn(db, AUTH_A);
    const byOwner = await db.query(`update settings set vat_pct = 14 where org_id = $1`, [ORG_A]);
    expect(byOwner.affectedRows).toBe(1);
  });
});

describe('the audit log', () => {
  it('can be appended to and read by the org', async () => {
    await signIn(db, AUTH_OPERATOR);
    await db.exec(`insert into events (org_id, type) values ('${ORG_A}', 'test.append')`);
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from events where org_id = $1 and type = 'test.append'`,
      [ORG_A],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('cannot be rewritten by anyone, in their own org or another', async () => {
    await signIn(db, AUTH_A);
    const updated = await db.query(`update events set type = 'tampered' where org_id = $1`, [
      ORG_A,
    ]);
    expect(updated.affectedRows).toBe(0);

    const deleted = await db.query(`delete from events where org_id = $1`, [ORG_A]);
    expect(deleted.affectedRows).toBe(0);
  });
});

describe('global reference data', () => {
  it('is readable by any signed-in user', async () => {
    await signIn(db, AUTH_B);
    const categories = await db.query<{ slug: string }>('select slug from service_categories');
    expect(categories.rows.map((r) => r.slug)).toContain(CATEGORY_SLUG);

    const bands = await db.query<{ count: number }>(
      'select count(*)::int as count from market_price_bands',
    );
    expect(bands.rows[0]?.count).toBeGreaterThan(0);
  });

  it('is not writable from the application', async () => {
    await signIn(db, AUTH_B);
    await expect(
      db.exec(`insert into service_categories (slug, name) values ('invented', 'Invented')`),
    ).rejects.toThrow(/permission denied/i);
    await expect(db.exec(`update market_price_bands set p50_minor = 1`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});
