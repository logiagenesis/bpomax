import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-502, the owner's audit S-05: what the signed-in person (the `authenticated` role
 * PostgREST and the API both use) may write, column by column, and that the columns the
 * application never lets them write cannot be written through the Data API either.
 * Every other table keeps 0008's grants; row-level security decides the rows.
 */
let db: PGlite;
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const OWNER_AUTH = fixtureId('a', ENTITY.authUser);
const OPERATOR = fixtureId('d', ENTITY.user);
const OPERATOR_AUTH = fixtureId('d', ENTITY.authUser);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const PROPOSAL = fixtureId('a', ENTITY.proposal);

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${OPERATOR}', '${OPERATOR_AUTH}', 'd@example.test')`);
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG}', '${OPERATOR}', 'operator')`,
  );
}, 60_000);

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

async function columns(table: string, privilege: 'INSERT' | 'UPDATE'): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public'
        and table_name = $1 and privilege_type = $2
      order by column_name`,
    [table, privilege],
  );
  return rows.map((r) => r.column_name);
}

async function refused(sql: string, params: unknown[] = []): Promise<string> {
  try {
    const result = await db.query(sql, params);
    return (result.affectedRows ?? 0) === 0 ? 'no rows' : 'allowed';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('what the signed-in person may write, by column', () => {
  it.each([
    ['users', 'UPDATE', []],
    [
      'platform_accounts',
      'INSERT',
      ['external_user_id', 'external_username', 'org_id', 'platform', 'scopes'],
    ],
    [
      'platform_accounts',
      'UPDATE',
      [
        'external_user_id',
        'external_username',
        'monthly_bid_allowance',
        'plan_name',
        'plan_recorded_on',
        'scopes',
      ],
    ],
    ['proposals', 'INSERT', []],
    ['proposals', 'UPDATE', ['approved_by', 'approved_via', 'body', 'failure_reason', 'status']],
    ['messages', 'INSERT', ['body', 'direction', 'org_id', 'origin', 'thread_id']],
    [
      'messages',
      'UPDATE',
      ['approved_by', 'approved_via', 'body', 'failure_reason', 'rejected_at'],
    ],
  ] as const)('%s %s', async (table, privilege, expected) => {
    expect(await columns(table, privilege)).toEqual([...expected]);
  });
});

describe('what cannot be written through the Data API', () => {
  it('a person cannot rewrite their own identity row', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await refused('update users set auth_user_id = gen_random_uuid() where id = $1', [OPERATOR]),
    ).toMatch(/permission denied/);
    expect(
      await refused(`update users set telegram_chat_id = 'someone-else' where id = $1`, [OPERATOR]),
    ).toMatch(/permission denied/);
  });

  it("a platform account's Vault secrets and status move only through the token functions", async () => {
    await signIn(db, OWNER_AUTH);
    expect(
      await refused(
        'update platform_accounts set access_token_secret_id = gen_random_uuid() where id = $1',
        [ACCOUNT],
      ),
    ).toMatch(/permission denied/);
    expect(
      await refused(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]),
    ).toMatch(/permission denied/);
    // What the settings page writes still works.
    expect(
      await refused(
        `update platform_accounts set plan_name = 'Plus', monthly_bid_allowance = 100 where id = $1`,
        [ACCOUNT],
      ),
    ).toBe('allowed');
  });

  it('a bid is drafted by the workers and sent by the sender, never by a person', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await refused(
        `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status, approved_by, approved_via)
         values ($1, $2, 'A bid that skipped the margin rule', 1, 'ZAR', 1, 'approved', $3, 'web')`,
        [ORG, fixtureId('a', ENTITY.job), OPERATOR],
      ),
    ).toMatch(/permission denied/);
    expect(
      await refused(
        `update proposals set platform_ref = 'fake', submitted_at = now() where id = $1`,
        [PROPOSAL],
      ),
    ).toMatch(/permission denied/);
    expect(
      await refused(
        `update proposals set status = 'submitted', approved_by = $2, approved_via = 'web' where id = $1`,
        [PROPOSAL, OPERATOR],
      ),
    ).toMatch(/row-level security/);
    // Approving in one's own name still works.
    await signOut(db);
    await db.query(
      `update proposals set status = 'queued', approved_by = null, approved_via = null where id = $1`,
      [PROPOSAL],
    );
    await signIn(db, OPERATOR_AUTH);
    expect(
      await refused(
        `update proposals set status = 'approved', approved_by = $2, approved_via = 'web' where id = $1`,
        [PROPOSAL, OPERATOR],
      ),
    ).toBe('allowed');
  });

  it('an audit event is written in the person own name or as the system, never in another person s', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await refused(
        `insert into events (org_id, type, actor_user_id, actor_kind) values ($1, 'settings.changed', $2, 'user')`,
        [ORG, OWNER],
      ),
    ).toMatch(/row-level security/);
    expect(
      await refused(
        `insert into events (org_id, type, actor_user_id, actor_kind) values ($1, 'settings.changed', $2, 'user')`,
        [ORG, OPERATOR],
      ),
    ).toBe('allowed');
  });

  it('a payment is recorded in the person own name, never in another person s', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await refused(
        `insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, paid_at, recorded_by, amount_zar_minor)
         values ($1, $2, 'in', 'client', 1000, 'ZAR', now(), $3, 1000)`,
        [ORG, fixtureId('a', ENTITY.pipelineItem), OWNER],
      ),
    ).toMatch(/row-level security/);
  });
});
