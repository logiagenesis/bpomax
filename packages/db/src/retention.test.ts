import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEvents } from './events.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { REDACTED_TEXT, purgeAll, purgeOrg } from './retention.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-015: the retention job.
 *
 * The period itself is T-06 and is not set here. What is proven is that the job does
 * nothing at all without one, that with one it closes conversations idle for the whole
 * period with no contract riding on them (ARB-520, the owner's audit P-01), redacts only
 * closed and expired conversations, and never touches the audit log it writes to.
 */
let db: PGlite;

const ORG = fixtureId('a', ENTITY.org);
const THREAD = fixtureId('a', ENTITY.thread);
const NOW = new Date('2026-09-22T12:00:00Z');

async function resetConversation(lastMessageAt: string, status: string): Promise<void> {
  await db.query(
    `update threads set status = $2, last_message_at = $3, redacted_at = null,
       client_handle = 'client-handle' where id = $1`,
    [THREAD, status, lastMessageAt],
  );
  await db.query(
    `update messages set body = 'The original message', redacted_at = null where thread_id = $1`,
    [THREAD],
  );
  await db.query(
    `update discovery_sessions set answers = '{"budget":"R20k"}'::jsonb, redacted_at = null
       where thread_id = $1`,
    [THREAD],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('with no retention period set', () => {
  it('stands down rather than choosing one', async () => {
    await resetConversation('2020-01-01T00:00:00Z', 'closed');
    const [result] = await purgeAll(db, NOW);

    expect(result?.status).toBe('skipped_no_period');
    expect(result?.threads).toBe(0);

    const { rows } = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`,
      [THREAD],
    );
    expect(rows[0]?.body).toBe('The original message');
  });

  it('says why in the audit log, rather than saying nothing', async () => {
    const [event] = await listEvents(db, { type: 'retention.purged' });
    expect(event?.outcome).toBe('skipped');
    expect(JSON.stringify(event?.payload)).toMatch(/T-06/);
  });

  it('is what stops live mode being switched on', async () => {
    await expect(
      db.query(
        `update settings set live_mode = true, min_margin_pct = 30, min_margin_zar_minor = 50000,
           fx_buffer_pct = 3, fee_table = '[{"platform":"freelancer"}]'::jsonb
         where org_id = $1`,
        [ORG],
      ),
    ).rejects.toThrow(/live_mode_requires_retention_period/i);
  });
});

describe('with a retention period set', () => {
  beforeAll(async () => {
    await db.query(`update settings set retention_days = 365 where org_id = $1`, [ORG]);
  });

  it('redacts a closed conversation that has gone quiet past the period', async () => {
    await resetConversation('2020-01-01T00:00:00Z', 'closed');
    const result = await purgeOrg(db, ORG, NOW);

    expect(result.status).toBe('purged');
    expect(result.threads).toBe(1);
    expect(result.messages).toBe(1);
    expect(result.discoverySessions).toBe(1);

    const thread = await db.query<{ client_handle: string | null; redacted_at: string | null }>(
      `select client_handle, redacted_at from threads where id = $1`,
      [THREAD],
    );
    expect(thread.rows[0]?.client_handle).toBeNull();
    expect(thread.rows[0]?.redacted_at).not.toBeNull();

    const message = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`,
      [THREAD],
    );
    expect(message.rows[0]?.body).toBe(REDACTED_TEXT);

    const session = await db.query<{ answers: Record<string, unknown> }>(
      `select answers from discovery_sessions where thread_id = $1`,
      [THREAD],
    );
    expect(session.rows[0]?.answers).toEqual({});
  });

  it('closes a conversation idle for the whole period, then redacts it (the owner audit, P-01)', async () => {
    // Before, nothing ever set a thread to closed, so this conversation was kept for ever.
    await resetConversation('2015-01-01T00:00:00Z', 'awaiting_client');
    const result = await purgeOrg(db, ORG, NOW);

    expect(result).toMatchObject({ closedIdle: 1, threads: 1 });
    const thread = await db.query<{ status: string; client_handle: string | null }>(
      'select status::text, client_handle from threads where id = $1',
      [THREAD],
    );
    expect(thread.rows[0]).toEqual({ status: 'closed', client_handle: null });
    const { rows } = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`,
      [THREAD],
    );
    expect(rows[0]?.body).toBe(REDACTED_TEXT);
  });

  it('leaves an open conversation with activity inside the period alone', async () => {
    await resetConversation('2026-09-20T00:00:00Z', 'open');
    const result = await purgeOrg(db, ORG, NOW);

    expect(result).toMatchObject({ closedIdle: 0, threads: 0 });
    const { rows } = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`,
      [THREAD],
    );
    expect(rows[0]?.body).toBe('The original message');
  });

  it.each(['won', 'in_delivery', 'delivered'])(
    'keeps an idle conversation while a contract rides on it (%s)',
    async (stage) => {
      await resetConversation('2015-01-01T00:00:00Z', 'awaiting_client');
      const jobId = fixtureId('a', ENTITY.job);
      await db.query('update threads set job_id = $2 where id = $1', [THREAD, jobId]);
      await db.query('update pipeline_items set stage = $2 where job_id = $1', [jobId, stage]);
      try {
        const result = await purgeOrg(db, ORG, NOW);
        expect(result).toMatchObject({ closedIdle: 0, threads: 0 });
        const { rows } = await db.query<{ status: string }>(
          'select status::text from threads where id = $1',
          [THREAD],
        );
        expect(rows[0]?.status).toBe('awaiting_client');
      } finally {
        await db.query(`update pipeline_items set stage = 'applied' where job_id = $1`, [jobId]);
      }
    },
  );

  it('leaves a closed conversation inside the period alone', async () => {
    await resetConversation('2026-09-01T00:00:00Z', 'closed');
    const result = await purgeOrg(db, ORG, NOW);

    expect(result.threads).toBe(0);
    const { rows } = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`,
      [THREAD],
    );
    expect(rows[0]?.body).toBe('The original message');
  });

  it('does not redact the same conversation twice', async () => {
    await resetConversation('2020-01-01T00:00:00Z', 'closed');
    expect((await purgeOrg(db, ORG, NOW)).threads).toBe(1);
    expect((await purgeOrg(db, ORG, NOW)).threads).toBe(0);
  });

  it('records every run in the audit log, including the empty ones', async () => {
    const events = await listEvents(db, { type: 'retention.purged' });
    expect(events.length).toBeGreaterThan(3);
    expect(events[0]?.payload).toHaveProperty('retention_days');
  });

  it('never redacts the audit log itself', async () => {
    await resetConversation('2020-01-01T00:00:00Z', 'closed');
    const before = await listEvents(db, { limit: 100 });
    await purgeOrg(db, ORG, NOW);
    const after = await listEvents(db, { limit: 100 });
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });
});
