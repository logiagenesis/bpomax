import type { PGlite } from '@electric-sql/pglite';
import { ROLES, canApprove, canChangeSettings, canWrite, type Role } from '@arbitron/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-012: the interface's idea of what a role may do, and the database's, must be the
 * same idea. `packages/core/src/auth.ts` is what greys out a button; RLS is what
 * actually refuses the write. A disagreement between them is either a button that lies
 * or a rule that is only pretending to be enforced, so it is a test failure here.
 */
let db: PGlite;

const ORG = fixtureId('a', ENTITY.org);

/** One member of org A per role, so each can be acted as in turn. */
const PEOPLE: Record<Role, { user: string; authUser: string }> = {
  owner: { user: fixtureId('a', ENTITY.user), authUser: fixtureId('a', ENTITY.authUser) },
  operator: { user: fixtureId('d', ENTITY.user), authUser: fixtureId('d', ENTITY.authUser) },
  viewer: { user: fixtureId('c', ENTITY.user), authUser: fixtureId('c', ENTITY.authUser) },
};

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);

  for (const role of ['viewer', 'operator'] as const) {
    const tag = role === 'viewer' ? 'c' : 'd';
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${ORG}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }
});

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

/** Did the database let this role do it? Errors and zero affected rows both mean no. */
async function permitted(work: () => Promise<{ affectedRows?: number }>): Promise<boolean> {
  try {
    const result = await work();
    return (result.affectedRows ?? 0) > 0;
  } catch {
    return false;
  }
}

describe.each(ROLES)('%s', (role) => {
  const { user, authUser } = PEOPLE[role];

  it('writes ordinary records exactly when canWrite says so', async () => {
    await signIn(db, authUser);
    const allowed = await permitted(() =>
      db.query(`insert into suppliers (org_id, name, channel) values ($1, $2, 'direct')`, [
        ORG,
        `Supplier by ${role}`,
      ]),
    );
    expect(allowed).toBe(canWrite(role));
  });

  it('approves exactly when canApprove says so', async () => {
    await signOut(db);
    const { rows } = await db.query<{ id: string }>(
      `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days)
       values ($1, $2, $3, 200000, 'ZAR', 7) returning id`,
      [ORG, fixtureId('a', ENTITY.job), `For ${role}`],
    );

    await signIn(db, authUser);
    const allowed = await permitted(() =>
      db.query(
        `update proposals set status = 'approved', approved_by = $1, approved_via = 'web' where id = $2`,
        [user, rows[0]!.id],
      ),
    );
    expect(allowed).toBe(canApprove(role));
  });

  it('changes settings exactly when canChangeSettings says so', async () => {
    await signIn(db, authUser);
    const allowed = await permitted(() =>
      db.query(`update settings set fx_buffer_pct = 2.5 where org_id = $1`, [ORG]),
    );
    expect(allowed).toBe(canChangeSettings(role));
  });

  it('always reads its own org', async () => {
    await signIn(db, authUser);
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from jobs where org_id = $1`,
      [ORG],
    );
    expect(rows[0]?.count).toBeGreaterThan(0);
  });
});
