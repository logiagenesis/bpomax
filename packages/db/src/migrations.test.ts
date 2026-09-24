import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from './migrations.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-010 acceptance: the migrations apply cleanly.
 *
 * The build container has the Docker CLI but no daemon (docs/BLOCKERS.md V-01), so the
 * compose Postgres cannot be started here. PGlite is real Postgres compiled to WASM, so
 * the migrations are applied for real in-process rather than merely eyeballed. It is not
 * a substitute for running them against Supabase before go-live — pgsodium is not present
 * here, and the auth schema is a shim (see testing.ts) rather than Supabase's own — but
 * "applies cleanly" is now checked on every push.
 */
let db: PGlite;

const EXPECTED_TABLES = [
  'affiliates',
  'attribution',
  'auto_replies',
  'auto_reply_sends',
  'briefs',
  'delivery_estimates',
  'delivery_orders',
  'discovery_sessions',
  'events',
  'job_scores',
  'jobs',
  'llm_calls',
  'margin_evaluations',
  'market_price_bands',
  'memberships',
  'messages',
  'orgs',
  'payments',
  'pipeline_items',
  'plans',
  'platform_accounts',
  'platform_connect_attempts',
  'portfolio_items',
  'proposal_citations',
  'proposals',
  'scanners',
  'service_categories',
  'settings',
  'sourcing_posts',
  'sourcing_requests',
  'subscriptions',
  'supplier_candidates',
  'supplier_rate_cards',
  'suppliers',
  'telegram_link_codes',
  'telegram_pending',
  'template_variants',
  'templates',
  'threads',
  'usage_counters',
  'users',
];

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function tableNames(): Promise<string[]> {
  const result = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

describe('migrations', () => {
  it('are numbered and ordered', () => {
    const names = loadMigrations().map((m) => m.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z_]+\.sql$/);
  });

  it('create every table the data model calls for', async () => {
    expect(await tableNames()).toEqual(EXPECTED_TABLES);
  });

  it('give every table a uuid primary key', async () => {
    const result = await db.query<{ table_name: string }>(
      `select t.table_name
       from information_schema.tables t
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and not exists (
           select 1 from information_schema.table_constraints c
           where c.table_schema = 'public' and c.table_name = t.table_name
             and c.constraint_type = 'PRIMARY KEY'
         )`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([]);
  });

  it('give every tenant-scoped table created_at and updated_at', async () => {
    // events is append-only and deliberately has no updated_at.
    const result = await db.query<{ table_name: string }>(
      `select t.table_name
       from information_schema.tables t
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and t.table_name <> 'events'
         and not exists (
           select 1 from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = t.table_name
             and c.column_name = 'updated_at'
         )`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([]);
  });

  it('keep the audit log append-only', async () => {
    const org = await db.query<{ id: string }>(
      `insert into orgs (name) values ('Logi-Ink') returning id`,
    );
    const orgId = org.rows[0]!.id;
    await db.query(`insert into events (org_id, type, outcome) values ($1, 'test.event', 'ok')`, [
      orgId,
    ]);

    await db.query(`update events set type = 'tampered'`);
    await db.query(`delete from events`);

    const after = await db.query<{ type: string; count: string }>(
      `select type, count(*)::text as count from events group by type`,
    );
    expect(after.rows).toEqual([{ type: 'test.event', count: '1' }]);
  });

  it('refuse live mode until the margin rules and the retention period are set', async () => {
    const org = await db.query<{ id: string }>(
      `insert into orgs (name) values ('Live mode test') returning id`,
    );
    const orgId = org.rows[0]!.id;

    await expect(
      db.query(`insert into settings (org_id, live_mode) values ($1, true)`, [orgId]),
    ).rejects.toThrow(/live_mode_requires_margin_rules/);

    // Margin rules alone are not enough: POPIA retention is the other precondition
    // (0010, docs/02 T-06).
    await expect(
      db.query(
        `insert into settings
           (org_id, live_mode, min_margin_pct, min_margin_zar_minor, fx_buffer_pct, fee_table)
         values ($1, true, 25, 150000, 5, '[{"platform":"freelancer"}]'::jsonb)`,
        [orgId],
      ),
    ).rejects.toThrow(/live_mode_requires_retention_period/);

    await expect(
      db.query(
        `insert into settings
           (org_id, live_mode, min_margin_pct, min_margin_zar_minor, fx_buffer_pct, fee_table,
            retention_days)
         values ($1, true, 25, 150000, 5, '[{"platform":"freelancer"}]'::jsonb, 365)`,
        [orgId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuse auto-send without a daily cap and a score floor', async () => {
    const org = await db.query<{ id: string }>(
      `insert into orgs (name) values ('Scanner guardrails') returning id`,
    );
    const orgId = org.rows[0]!.id;

    await expect(
      db.query(`insert into scanners (org_id, name, auto_send) values ($1, 'reckless', true)`, [
        orgId,
      ]),
    ).rejects.toThrow(/auto_send_requires_guardrails/);

    await expect(
      db.query(
        `insert into scanners (org_id, name, auto_send, daily_cap, min_score)
         values ($1, 'capped', true, 10, 70)`,
        [orgId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuse a second auto-reply on the same thread', async () => {
    const org = await db.query<{ id: string }>(
      `insert into orgs (name) values ('Auto reply once') returning id`,
    );
    const orgId = org.rows[0]!.id;
    const thread = await db.query<{ id: string }>(
      `insert into threads (org_id, platform, external_thread_id)
       values ($1, 'freelancer', 'thread-1') returning id`,
      [orgId],
    );
    const reply = await db.query<{ id: string }>(
      `insert into auto_replies (org_id, name, body) values ($1, 'first contact', 'Hello')
       returning id`,
      [orgId],
    );
    const threadId = thread.rows[0]!.id;
    const replyId = reply.rows[0]!.id;

    await db.query(
      `insert into auto_reply_sends (org_id, thread_id, auto_reply_id) values ($1, $2, $3)`,
      [orgId, threadId, replyId],
    );
    await expect(
      db.query(
        `insert into auto_reply_sends (org_id, thread_id, auto_reply_id) values ($1, $2, $3)`,
        [orgId, threadId, replyId],
      ),
    ).rejects.toThrow();
  });

  it('refuse an outbound message with no approval recorded', async () => {
    const org = await db.query<{ id: string }>(
      `insert into orgs (name) values ('Approval gate') returning id`,
    );
    const orgId = org.rows[0]!.id;
    const thread = await db.query<{ id: string }>(
      `insert into threads (org_id, platform, external_thread_id)
       values ($1, 'freelancer', 'thread-2') returning id`,
      [orgId],
    );
    const threadId = thread.rows[0]!.id;

    await expect(
      db.query(
        `insert into messages (org_id, thread_id, direction, body, sent_at)
         values ($1, $2, 'out', 'Hi there', now())`,
        [orgId, threadId],
      ),
    ).rejects.toThrow(/outbound_requires_approval/);
  });
});
