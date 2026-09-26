import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-500: the owner's audit LI-AUDIT-BPOMAX-TASKS-20260925, S-01 and S-02, in the
 * database under the real `authenticated` role. Every assertion here failed on the
 * policies of 0016 and the columns of 0004.
 */
let db: PGlite;

const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const OWNER_AUTH = fixtureId('a', ENTITY.authUser);
const OPERATOR = fixtureId('d', ENTITY.user);
const OPERATOR_AUTH = fixtureId('d', ENTITY.authUser);
const VIEWER = fixtureId('c', ENTITY.user);
const VIEWER_AUTH = fixtureId('c', ENTITY.authUser);
const OWNER_CODE = fixtureId('a', ENTITY.telegramLinkCode);

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${ORG}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }
}, 60_000);

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

/** Did the database let it happen? An error and zero rows both mean no. */
async function permitted(work: () => Promise<{ affectedRows?: number }>): Promise<boolean> {
  try {
    const result = await work();
    return (result.affectedRows ?? 0) > 0;
  } catch {
    return false;
  }
}

const later = () => new Date(Date.now() + 10 * 60_000).toISOString();

describe('Telegram link codes belong to the person they name (S-01)', () => {
  it('refuses an operator a code that names the owner', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await permitted(() =>
        db.query(
          `insert into telegram_link_codes (org_id, user_id, code, expires_at) values ($1, $2, 'TAKEOVER', $3)`,
          [ORG, OWNER, later()],
        ),
      ),
    ).toBe(false);
  });

  it('lets an operator make a code for themselves, unused', async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await permitted(() =>
        db.query(
          `insert into telegram_link_codes (org_id, user_id, code, expires_at) values ($1, $2, 'OPERATOR1', $3)`,
          [ORG, OPERATOR, later()],
        ),
      ),
    ).toBe(true);
    expect(
      await permitted(() =>
        db.query(
          `insert into telegram_link_codes (org_id, user_id, code, expires_at, used_at)
           values ($1, $2, 'PREUSED1', $3, now())`,
          [ORG, OPERATOR, later()],
        ),
      ),
    ).toBe(false);
  });

  it('refuses a viewer any code, even their own', async () => {
    await signIn(db, VIEWER_AUTH);
    expect(
      await permitted(() =>
        db.query(
          `insert into telegram_link_codes (org_id, user_id, code, expires_at) values ($1, $2, 'VIEWER01', $3)`,
          [ORG, VIEWER, later()],
        ),
      ),
    ).toBe(false);
  });

  it('shows each person only their own codes', async () => {
    await signIn(db, OPERATOR_AUTH);
    const seen = await db.query<{ user_id: string }>('select user_id from telegram_link_codes');
    expect(seen.rows.length).toBeGreaterThan(0);
    expect(new Set(seen.rows.map((r) => r.user_id))).toEqual(new Set([OPERATOR]));

    await signIn(db, OWNER_AUTH);
    const owners = await db.query<{ id: string; user_id: string }>(
      'select id, user_id from telegram_link_codes',
    );
    expect(owners.rows.map((r) => r.id)).toContain(OWNER_CODE);
    expect(new Set(owners.rows.map((r) => r.user_id))).toEqual(new Set([OWNER]));
  });

  it('lets nobody change a code from the application, not even its own person', async () => {
    for (const auth of [OPERATOR_AUTH, OWNER_AUTH]) {
      await signIn(db, auth);
      expect(
        await permitted(() =>
          db.query(`update telegram_link_codes set expires_at = $2 where id = $1`, [
            OWNER_CODE,
            later(),
          ]),
        ),
      ).toBe(false);
      expect(
        await permitted(() =>
          db.query(`update telegram_link_codes set user_id = $2 where id = $1`, [
            OWNER_CODE,
            OPERATOR,
          ]),
        ),
      ).toBe(false);
    }
    await signOut(db);
    const { rows } = await db.query<{ user_id: string }>(
      'select user_id from telegram_link_codes where id = $1',
      [OWNER_CODE],
    );
    expect(rows[0]?.user_id).toBe(OWNER);
  });

  it("refuses an operator the deletion of the owner's code", async () => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await permitted(() =>
        db.query('delete from telegram_link_codes where id = $1', [OWNER_CODE]),
      ),
    ).toBe(false);
  });

  it("keeps the bot's pending actions out of the application's reach", async () => {
    await signIn(db, OPERATOR_AUTH);
    const proposal = fixtureId('a', ENTITY.proposal);
    expect(
      await permitted(() =>
        db.query(
          `insert into telegram_pending (org_id, chat_id, action, proposal_id) values ($1, 'owner-chat', 'edit', $2)`,
          [ORG, proposal],
        ),
      ),
    ).toBe(false);
    expect(await permitted(() => db.query(`update telegram_pending set action = 'reject'`))).toBe(
      false,
    );
    expect(await permitted(() => db.query('delete from telegram_pending'))).toBe(false);
  });
});

describe('profile links are web addresses (S-02)', () => {
  const bad = [
    'javascript:alert(document.domain)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/profile',
  ];

  it.each(bad)('refuses a supplier whose profile is %s, however it is written', async (url) => {
    await signIn(db, OPERATOR_AUTH);
    expect(
      await permitted(() =>
        db.query(
          `insert into suppliers (org_id, name, channel, external_profile_url) values ($1, $2, 'direct', $3)`,
          [ORG, `Bad ${url.slice(0, 12)}`, url],
        ),
      ),
    ).toBe(false);
    const existing = fixtureId('a', ENTITY.supplier);
    expect(
      await permitted(() =>
        db.query('update suppliers set external_profile_url = $2 where id = $1', [existing, url]),
      ),
    ).toBe(false);
  });

  it('accepts http and https profiles, and none at all', async () => {
    await signIn(db, OPERATOR_AUTH);
    for (const [name, url] of [
      ['Secure', 'https://example.com/profile'],
      ['Plain', 'HTTP://example.com/profile'],
      ['Without', null],
    ] as const) {
      expect(
        await permitted(() =>
          db.query(
            `insert into suppliers (org_id, name, channel, external_profile_url) values ($1, $2, 'direct', $3)`,
            [ORG, name, url],
          ),
        ),
      ).toBe(true);
    }
  });

  it('holds candidates to the same rule', async () => {
    await signOut(db);
    const request = fixtureId('a', ENTITY.sourcingRequest);
    await expect(
      db.query(
        `insert into supplier_candidates (org_id, sourcing_request_id, external_profile_url, display_name)
         values ($1, $2, 'javascript:alert(1)', 'Bad')`,
        [ORG, request],
      ),
    ).rejects.toThrow(/supplier_candidates_profile_url_is_web/);
    await db.query(
      `insert into supplier_candidates (org_id, sourcing_request_id, external_profile_url, display_name)
       values ($1, $2, 'https://example.com/c', 'Good')`,
      [ORG, request],
    );
  });
});
