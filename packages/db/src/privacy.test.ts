import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from './client.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { ERASED_TEXT, eraseClient, exportClient, exportPerson, personColumns } from './privacy.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-521, the owner's audit P-04: a person can have what is held about them, and a
 * marketplace client's conversation can be erased, without the audit log keeping their
 * words.
 */
let db: PGlite;
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const USER_A = fixtureId('a', ENTITY.user);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const USER_B = fixtureId('b', ENTITY.user);

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
  // The same client handle in both orgs, in two case spellings in org a.
  await db.query(`update threads set client_handle = 'Acme_Ltd' where org_id = $1`, [ORG_A]);
  await db.query(`update threads set client_handle = 'acme_ltd' where org_id = $1`, [ORG_B]);
  await db.query(
    `insert into threads (org_id, platform, external_thread_id, client_handle)
     values ($1, 'freelancer', 'second-thread', 'ACME_LTD')`,
    [ORG_A],
  );
  await db.query(
    `insert into messages (org_id, thread_id, direction, body)
     select org_id, id, 'in', 'My phone is 082 555 0100' from threads
      where external_thread_id = 'second-thread'`,
  );
  await db.query(
    `insert into threads (org_id, platform, external_thread_id, client_handle)
     values ($1, 'freelancer', 'someone-else', 'another_client')`,
    [ORG_A],
  );
  await db.query(
    `insert into messages (org_id, thread_id, direction, body)
     select org_id, id, 'in', 'Not the one asking' from threads
      where external_thread_id = 'someone-else'`,
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('what names a person who uses the app', () => {
  it('is every foreign key to users: a new one fails here until the export is checked for it', async () => {
    expect((await personColumns(db)).map((c) => `${c.table}.${c.column}`)).toEqual([
      'auto_replies.approved_by',
      'billing_checkouts.created_by',
      'events.actor_user_id',
      'memberships.user_id',
      'messages.approved_by',
      'payments.recorded_by',
      'platform_connect_attempts.user_id',
      'proposals.approved_by',
      'sourcing_posts.approved_by',
      'telegram_link_codes.user_id',
    ]);
  });
});

describe("a person's own data", () => {
  it('holds who they are, where they belong and every row naming them, as they may see it', async () => {
    await db.query(
      `insert into events (org_id, type, actor_user_id, actor_kind, payload)
       values ($1, 'settings.changed', $2, 'user', '{"field":"vat_pct"}')`,
      [ORG_A, USER_A],
    );
    await db.query(
      `insert into events (org_id, type, actor_user_id, actor_kind)
       values ($1, 'settings.changed', $2, 'user')`,
      [ORG_B, USER_B],
    );
    const data = await withUser(db, AUTH_A, (tx) => exportPerson(tx, USER_A));
    expect(data.person).toMatchObject({
      id: USER_A,
      email: 'a@example.test',
      full_name: 'User a',
      telegram_linked: true,
    });
    expect(data.memberships).toEqual([
      expect.objectContaining({ org_id: ORG_A, org_name: 'Org a', role: 'owner' }),
    ]);
    expect(Object.keys(data.namedIn).sort()).toEqual(
      (await personColumns(db))
        .filter((c) => c.table !== 'memberships')
        .map((c) => `${c.table}.${c.column}`)
        .sort(),
    );
    const events = data.namedIn['events.actor_user_id']!;
    expect(events.some((e) => e.type === 'settings.changed' && e.org_id === ORG_A)).toBe(true);
    expect(events.every((e) => e.org_id === ORG_A)).toBe(true);
    // Rows other than the audit log carry their id and time, not what else they hold.
    for (const [key, rows] of Object.entries(data.namedIn)) {
      if (key === 'events.actor_user_id') continue;
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(['created_at', 'id']);
    }
  });

  it("is never another person's, even asked for by id", async () => {
    const data = await withUser(db, AUTH_A, (tx) => exportPerson(tx, USER_B));
    expect(data.person).toBeNull();
    expect(data.memberships).toEqual([]);
    for (const rows of Object.values(data.namedIn)) expect(rows).toEqual([]);
  });
});

describe("a marketplace client's data", () => {
  it('is found by handle whatever its case, in this org only', async () => {
    const data = await exportClient(db, ORG_A, 'acme_ltd');
    expect(data.threads).toHaveLength(2);
    expect(data.threads.every((t) => String(t.client_handle).toLowerCase() === 'acme_ltd')).toBe(
      true,
    );
    expect(data.messages.map((m) => m.body)).toContain('My phone is 082 555 0100');
    expect(data.messages.map((m) => m.body)).not.toContain('Not the one asking');
    expect(data.discoverySessions).toHaveLength(1);
    const elsewhere = await exportClient(db, ORG_B, 'acme_ltd');
    expect(elsewhere.threads).toHaveLength(1);
  });

  it('holds nothing for a handle the org has never talked to', async () => {
    expect(await exportClient(db, ORG_A, 'nobody_here')).toEqual({
      handle: 'nobody_here',
      threads: [],
      messages: [],
      discoverySessions: [],
      briefs: [],
    });
  });

  it('erasure takes their handle, words and answers in this org, and the audit log keeps none of it', async () => {
    await db.query(
      `update discovery_sessions set answers = '{"budget":"R5 000"}'::jsonb where org_id = $1`,
      [ORG_A],
    );
    const result = await eraseClient(db, {
      orgId: ORG_A,
      handle: 'ACME_ltd',
      actorUserId: USER_A,
      requestId: 'req-1',
    });
    expect(result).toEqual({ threads: 2, messages: 2, discoverySessions: 1 });

    expect((await exportClient(db, ORG_A, 'acme_ltd')).threads).toEqual([]);
    const { rows: messages } = await db.query<{ body: string; redacted_at: unknown }>(
      `select m.body, m.redacted_at from messages m join threads t on t.id = m.thread_id
        where t.org_id = $1 and t.redacted_at is not null`,
      [ORG_A],
    );
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.body === ERASED_TEXT && m.redacted_at !== null)).toBe(true);
    const { rows: sessions } = await db.query<{ answers: unknown }>(
      `select answers from discovery_sessions where org_id = $1`,
      [ORG_A],
    );
    expect(sessions).toEqual([{ answers: {} }]);
    const { rows: closed } = await db.query<{ status: string }>(
      `select status::text as status from threads where org_id = $1 and redacted_at is not null`,
      [ORG_A],
    );
    expect(closed.map((t) => t.status)).toEqual(['closed', 'closed']);

    // Another client in the same org, and the same handle in another org, are untouched.
    expect((await exportClient(db, ORG_A, 'another_client')).messages).toEqual([
      expect.objectContaining({ body: 'Not the one asking' }),
    ]);
    expect((await exportClient(db, ORG_B, 'acme_ltd')).threads).toHaveLength(1);

    const { rows: events } = await db.query<{ payload: unknown; outcome: string }>(
      `select payload, outcome::text as outcome from events where type = 'privacy.erased'`,
    );
    expect(events).toEqual([
      { payload: { threads: 2, messages: 2, discovery_sessions: 1 }, outcome: 'ok' },
    ]);
    const { rows: leaks } = await db.query(
      `select id from events where payload::text ilike '%acme%' or payload::text like '%082 555%'`,
    );
    expect(leaks).toEqual([]);
  });

  it('erasing a handle held nowhere changes nothing and says so in the audit log', async () => {
    const result = await eraseClient(db, {
      orgId: ORG_A,
      handle: 'nobody_here',
      actorUserId: USER_A,
    });
    expect(result).toEqual({ threads: 0, messages: 0, discoverySessions: 0 });
    const { rows } = await db.query<{ outcome: string }>(
      `select outcome::text as outcome from events where type = 'privacy.erased' order by created_at desc limit 1`,
    );
    expect(rows[0]?.outcome).toBe('skipped');
  });
});
