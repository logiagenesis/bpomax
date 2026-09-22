import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-012 acceptance: "Viewer cannot approve; operator can; owner can change settings."
 *
 * The three sentences are asserted literally below, against real Postgres under the real
 * `authenticated` role. Identity itself is Supabase's — `auth.users` here is the shim
 * described in DECISIONS.md D-012 — but the provisioning trigger, the role split and the
 * approval-integrity rules are this schema's, and they are what is proven.
 */
let db: PGlite;

const ORG_A = fixtureId('a', ENTITY.org);
const USER_OWNER = fixtureId('a', ENTITY.user);
const USER_VIEWER = fixtureId('c', ENTITY.user);
const USER_OPERATOR = fixtureId('d', ENTITY.user);
const AUTH_OWNER = fixtureId('a', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);

/** A fresh draft proposal for org A, so one test's approval cannot set up the next. */
let proposalCounter = 0;
async function newProposal(): Promise<string> {
  proposalCounter += 1;
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days)
     values ($1, $2, $3, 200000, 'ZAR', 7) returning id`,
    [ORG_A, fixtureId('a', ENTITY.job), `Draft ${proposalCounter}`],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);

  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }
});

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

describe('a new Supabase identity', () => {
  it('gets exactly one application user and no org', async () => {
    const authId = '99999999-0000-4000-8000-000000000001';
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
      authId,
      'newcomer@example.test',
    ]);

    const users = await db.query<{ id: string; email: string }>(
      `select id, email from users where auth_user_id = $1`,
      [authId],
    );
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]?.email).toBe('newcomer@example.test');

    // Signing up must not put anyone inside a tenant.
    const memberships = await db.query<{ count: number }>(
      `select count(*)::int as count from memberships where user_id = $1`,
      [users.rows[0]!.id],
    );
    expect(memberships.rows[0]?.count).toBe(0);
  });

  it('is not duplicated when the same identity is seen again', async () => {
    const authId = '99999999-0000-4000-8000-000000000002';
    await db.query(`insert into auth.users (id, email) values ($1, 'twice@example.test')`, [
      authId,
    ]);
    await db.exec(`
      insert into public.users (auth_user_id, email) values ('${authId}', 'twice@example.test')
      on conflict (auth_user_id) do update set email = excluded.email`);

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from users where auth_user_id = $1`,
      [authId],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('loses every door when the identity is deleted, without losing the audit trail', async () => {
    const authId = '99999999-0000-4000-8000-000000000003';
    await db.query(`insert into auth.users (id, email) values ($1, 'leaver@example.test')`, [
      authId,
    ]);
    const { rows } = await db.query<{ id: string }>(
      `select id from users where auth_user_id = $1`,
      [authId],
    );
    const appUserId = rows[0]!.id;
    await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'operator')`, [
      ORG_A,
      appUserId,
    ]);

    await signIn(db, authId);
    const before = await db.query<{ count: number }>(
      `select count(*)::int as count from suppliers where org_id = $1`,
      [ORG_A],
    );
    expect(before.rows[0]?.count).toBeGreaterThan(0);

    await signOut(db);
    await db.query(`delete from auth.users where id = $1`, [authId]);

    // The application row survives, so events.actor_user_id still resolves to a person.
    const survivor = await db.query<{ email: string; auth_user_id: string | null }>(
      `select email, auth_user_id from users where id = $1`,
      [appUserId],
    );
    expect(survivor.rows[0]?.email).toBe('leaver@example.test');
    expect(survivor.rows[0]?.auth_user_id).toBeNull();

    await signIn(db, authId);
    const after = await db.query<{ count: number }>(
      `select count(*)::int as count from suppliers where org_id = $1`,
      [ORG_A],
    );
    expect(after.rows[0]?.count).toBe(0);
  });
});

describe('approval', () => {
  it('is refused to a viewer', async () => {
    const proposal = await newProposal();
    await signIn(db, AUTH_VIEWER);
    const result = await db.query(
      `update proposals set status = 'approved', approved_by = $1, approved_via = 'web' where id = $2`,
      [USER_VIEWER, proposal],
    );
    expect(result.affectedRows).toBe(0);

    await signOut(db);
    const { rows } = await db.query<{ status: string }>(
      `select status from proposals where id = $1`,
      [proposal],
    );
    expect(rows[0]?.status).toBe('draft');
  });

  it('is allowed to an operator', async () => {
    const proposal = await newProposal();
    await signIn(db, AUTH_OPERATOR);
    const result = await db.query(
      `update proposals set status = 'approved', approved_by = $1, approved_via = 'web' where id = $2`,
      [USER_OPERATOR, proposal],
    );
    expect(result.affectedRows).toBe(1);

    await signOut(db);
    const { rows } = await db.query<{ status: string; approved_by: string }>(
      `select status, approved_by from proposals where id = $1`,
      [proposal],
    );
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.approved_by).toBe(USER_OPERATOR);
  });

  it('cannot be recorded in someone else s name', async () => {
    const proposal = await newProposal();
    await signIn(db, AUTH_OPERATOR);
    await expect(
      db.query(
        `update proposals set status = 'approved', approved_by = $1, approved_via = 'web' where id = $2`,
        [USER_OWNER, proposal],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('holds the same rule for outbound messages and sourcing posts', async () => {
    await signIn(db, AUTH_OPERATOR);
    await expect(
      db.query(
        `insert into messages (org_id, thread_id, direction, body, sent_at, approved_by, approved_via)
         values ($1, $2, 'out', 'Hello', now(), $3, 'web')`,
        [ORG_A, fixtureId('a', ENTITY.thread), USER_OWNER],
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      db.query(
        `insert into sourcing_posts (org_id, sourcing_request_id, platform, body, status, approved_by, approved_via)
         values ($1, $2, 'freelancer', 'Scope', 'posted', $3, 'web')`,
        [ORG_A, fixtureId('a', ENTITY.sourcingRequest), USER_OWNER],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('settings', () => {
  it('are changed by an owner', async () => {
    await signIn(db, AUTH_OWNER);
    const result = await db.query(`update settings set fx_buffer_pct = 3.5 where org_id = $1`, [
      ORG_A,
    ]);
    expect(result.affectedRows).toBe(1);
  });

  it('are not changed by an operator or a viewer', async () => {
    for (const authUser of [AUTH_OPERATOR, AUTH_VIEWER]) {
      await signIn(db, authUser);
      const result = await db.query(`update settings set fx_buffer_pct = 99 where org_id = $1`, [
        ORG_A,
      ]);
      expect(result.affectedRows).toBe(0);
    }
  });
});

describe('an org', () => {
  it('cannot be left without an owner', async () => {
    await expect(
      db.query(`delete from memberships where org_id = $1 and role = 'owner'`, [ORG_A]),
    ).rejects.toThrow(/at least one owner/i);

    await expect(
      db.query(`update memberships set role = 'viewer' where org_id = $1 and role = 'owner'`, [
        ORG_A,
      ]),
    ).rejects.toThrow(/at least one owner/i);
  });

  it('lets an owner step down once another owner exists', async () => {
    const second = '99999999-0000-4000-8000-000000000004';
    await db.query(`insert into auth.users (id, email) values ($1, 'second-owner@example.test')`, [
      second,
    ]);
    await db.query(
      `insert into memberships (org_id, user_id, role)
       select $1, id, 'owner' from users where auth_user_id = $2`,
      [ORG_A, second],
    );

    const result = await db.query(
      `update memberships set role = 'operator' where org_id = $1 and user_id = $2`,
      [ORG_A, USER_OWNER],
    );
    expect(result.affectedRows).toBe(1);

    // Put it back, so the order tests run in cannot change what they assert.
    await db.query(`update memberships set role = 'owner' where org_id = $1 and user_id = $2`, [
      ORG_A,
      USER_OWNER,
    ]);
  });
});
