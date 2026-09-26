import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ENTITY,
  REFERENCE_ROWS,
  TENANT_TABLES,
  fixtureId,
  identityRows,
  tenantRows,
} from './fixtures.js';
import { recordPublishedTerms } from './terms.js';
import { createTestDatabase, signIn, signInAsNobody, signOut } from './testing.js';

/**
 * ARB-400 acceptance: a new org is isolated from the Logi-Ink org.
 *
 * Logi-Ink (tag a) has a row in every tenant table. A stranger signs up (Supabase makes
 * their identity; migration 0009's trigger makes their application user), creates their
 * own org through `app.create_org` (migration 0032), and the new org is then given a
 * row in every tenant table too. Every assertion is made under the real `authenticated`
 * role with RLS on, in both directions: the new owner cannot reach Logi-Ink, and
 * Logi-Ink's owner cannot reach the new org.
 */
let db: PGlite;

const LOGI_INK = fixtureId('a', ENTITY.org);
const AUTH_LOGI_INK = fixtureId('a', ENTITY.authUser);
const AUTH_NEW = fixtureId('e', ENTITY.authUser);
const USER_NEW = fixtureId('e', ENTITY.user);
const AUTH_LATE = fixtureId('f', ENTITY.authUser);
let newOrg: string;
/** The terms on show, accepted by whoever makes an org (ARB-522, terms.test.ts). */
const TERMS = 'v1';

async function createOrg(name: string, country = 'ZA'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select app.create_org($1, $2, $3, null, $4) as id`,
    [name, country, 'req-signup', TERMS],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  await db.exec(`update orgs set name = 'Logi-Ink' where id = '${LOGI_INK}'`);
  for (const row of tenantRows(LOGI_INK, 'a', 'a')) await db.exec(row.sql);
  await recordPublishedTerms(db, { version: TERMS, approvedOn: '2026-10-01' });

  // The stranger signs up. Their application user is given the fixture id first, so the
  // fixture rows below can point at it; the trigger then links the identity to it.
  await db.exec(`insert into users (id, auth_user_id, email)
                 values ('${USER_NEW}', '${AUTH_NEW}', 'new@example.test')`);
  await db.query(`insert into auth.users (id, email) values ($1, 'new@example.test')`, [AUTH_NEW]);

  await signIn(db, AUTH_NEW);
  newOrg = await createOrg('New Studio', 'gb');
  await signOut(db);

  // The new org then fills up like any tenant: one row in every table, except the two
  // `create_org` already made (the owner's membership and the settings row).
  for (const row of tenantRows(newOrg, 'e', 'e')) {
    if (row.table === 'memberships' || row.table === 'settings') continue;
    await db.exec(row.sql);
  }
}, 60_000);

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

describe('app.create_org', () => {
  it('makes the person the owner of a new org, with empty settings and an event', async () => {
    const org = await db.query<{ name: string; country_code: string; base_currency: string }>(
      `select name, country_code, base_currency from orgs where id = $1`,
      [newOrg],
    );
    expect(org.rows).toEqual([{ name: 'New Studio', country_code: 'GB', base_currency: 'ZAR' }]);

    const members = await db.query<{ user_id: string; role: string }>(
      `select user_id, role::text as role from memberships where org_id = $1`,
      [newOrg],
    );
    expect(members.rows).toEqual([{ user_id: USER_NEW, role: 'owner' }]);

    const settings = await db.query(
      `select min_margin_pct, min_margin_zar_minor, fx_buffer_pct, fee_table, live_mode
       from settings where org_id = $1`,
      [newOrg],
    );
    expect(settings.rows).toEqual([
      {
        min_margin_pct: null,
        min_margin_zar_minor: null,
        fx_buffer_pct: null,
        fee_table: [],
        live_mode: false,
      },
    ]);

    const events = await db.query(
      `select type, actor_user_id, actor_kind, subject_id, request_id, outcome, payload
       from events where org_id = $1 and type = 'org.created'`,
      [newOrg],
    );
    expect(events.rows).toEqual([
      {
        type: 'org.created',
        actor_user_id: USER_NEW,
        actor_kind: 'user',
        subject_id: newOrg,
        request_id: 'req-signup',
        outcome: 'ok',
        payload: { name: 'New Studio', countryCode: 'GB', termsVersion: 'v1' },
      },
    ]);
  });

  it('refuses a second org for the same person', async () => {
    await signIn(db, AUTH_NEW);
    await expect(createOrg('Another')).rejects.toThrow(/already a member of an organisation/);
  });

  it('refuses someone who is already in any org, as any role', async () => {
    await signIn(db, AUTH_LOGI_INK);
    await expect(createOrg('Side project')).rejects.toThrow(/already a member/);
  });

  it('refuses a session with nobody signed in', async () => {
    await signInAsNobody(db);
    await expect(createOrg('Nobody')).rejects.toThrow(/sign in first/);
  });

  it('refuses an identity whose application user does not exist', async () => {
    await signIn(db, fixtureId('9', ENTITY.authUser));
    await expect(createOrg('Ghost')).rejects.toThrow(/no application user/);
  });

  it.each([
    ['', 'ZA', /1 to 100 characters/],
    ['   ', 'ZA', /1 to 100 characters/],
    ['x'.repeat(101), 'ZA', /1 to 100 characters/],
    ['Fine', 'ZAF', /two-letter/],
    ['Fine', '', /two-letter/],
  ])('refuses the name %j with country %j, and creates nothing', async (name, country, error) => {
    await db.query(
      `insert into auth.users (id, email) values ($1, 'late@example.test')
                    on conflict do nothing`,
      [AUTH_LATE],
    );
    const before = await db.query<{ count: number }>(`select count(*)::int as count from orgs`);
    await signIn(db, AUTH_LATE);
    await expect(createOrg(name, country)).rejects.toThrow(error);
    await signOut(db);
    const after = await db.query<{ count: number }>(`select count(*)::int as count from orgs`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('is not open to the anon role', async () => {
    await db.exec('set role anon');
    await expect(createOrg('Anon')).rejects.toThrow(/permission denied/);
  });

  it('cannot be reached any other way: orgs and memberships stay closed to inserts', async () => {
    await signIn(db, AUTH_LATE);
    await expect(db.exec(`insert into orgs (name) values ('Direct')`)).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      db.exec(`insert into memberships (org_id, user_id, role)
               select '${LOGI_INK}', id, 'owner' from users where auth_user_id = '${AUTH_LATE}'`),
    ).rejects.toThrow(/row-level security/);
  });
});

describe.each(TENANT_TABLES)('%s: new org and Logi-Ink are isolated', (table) => {
  it('the new owner sees their own rows and none of Logi-Ink s', async () => {
    await signIn(db, AUTH_NEW);
    const theirs = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [LOGI_INK],
    );
    expect(theirs.rows[0]?.count).toBe(0);
    const mine = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [newOrg],
    );
    expect(mine.rows[0]?.count).toBeGreaterThan(0);
  });

  it('Logi-Ink s owner sees none of the new org s rows', async () => {
    await signIn(db, AUTH_LOGI_INK);
    const theirs = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [newOrg],
    );
    expect(theirs.rows[0]?.count).toBe(0);
  });

  it('the new owner can neither add to, change nor remove Logi-Ink s rows', async () => {
    const row = tenantRows(LOGI_INK, 'a', 'd').find((candidate) => candidate.table === table);
    expect(row, `no fixture row for ${table}`).toBeDefined();
    await signIn(db, AUTH_NEW);
    // Refused by row-level security, or before it by a column grant (0038, ARB-502).
    await expect(db.exec(row!.sql)).rejects.toThrow(/row-level security|permission denied/i);

    // A column the person may not write at all is refused outright (0038): no change either.
    const updated = await db
      .query(`update ${table} set org_id = org_id where org_id = $1`, [LOGI_INK])
      .catch((error: Error) => {
        if (/permission denied/i.test(error.message)) return { affectedRows: 0 };
        throw error;
      });
    expect(updated.affectedRows).toBe(0);
    const deleted = await db.query(`delete from ${table} where org_id = $1`, [LOGI_INK]);
    expect(deleted.affectedRows).toBe(0);

    await signOut(db);
    const survivors = await db.query<{ count: number }>(
      `select count(*)::int as count from ${table} where org_id = $1`,
      [LOGI_INK],
    );
    expect(survivors.rows[0]?.count).toBeGreaterThan(0);
  });
});

describe('orgs and people', () => {
  it('each owner sees only their own org', async () => {
    await signIn(db, AUTH_NEW);
    const mine = await db.query<{ name: string }>(`select name from orgs`);
    expect(mine.rows).toEqual([{ name: 'New Studio' }]);
    await signIn(db, AUTH_LOGI_INK);
    const theirs = await db.query<{ name: string }>(`select name from orgs`);
    expect(theirs.rows).toEqual([{ name: 'Logi-Ink' }]);
  });

  it('neither sees the other s people', async () => {
    await signIn(db, AUTH_NEW);
    const mine = await db.query<{ email: string }>(`select email from users order by email`);
    expect(mine.rows.map((r) => r.email)).toEqual(['new@example.test']);
    await signIn(db, AUTH_LOGI_INK);
    const theirs = await db.query<{ email: string }>(`select email from users order by email`);
    expect(theirs.rows.map((r) => r.email)).toEqual(['a@example.test']);
  });

  it('the new owner cannot rename Logi-Ink or add themselves to it', async () => {
    await signIn(db, AUTH_NEW);
    const renamed = await db.query(`update orgs set name = 'Taken' where id = $1`, [LOGI_INK]);
    expect(renamed.affectedRows).toBe(0);
    await expect(
      db.exec(`insert into memberships (org_id, user_id, role)
               values ('${LOGI_INK}', '${USER_NEW}', 'viewer')`),
    ).rejects.toThrow(/row-level security/);
  });
});
