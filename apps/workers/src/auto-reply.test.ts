import { listEvents, putPlatformTokens, textFingerprint } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import {
  FreelancerError,
  exchangeCode,
  freelancerConfig,
  type FreelancerConfig,
} from '@arbitron/freelancer';
import { startFakeFreelancer, type FakeFreelancer } from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoReply, type AutoReplyDeps } from './auto-reply.js';

/**
 * ARB-121 acceptance: "Second inbound message never triggers a second auto-reply". Real
 * Postgres (PGlite) for the rows and the unique key, the stand-in of Freelancer.com over
 * HTTP for the one send that live mode lets through. LIVE_MODE is off unless a test
 * turns both switches on.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const JOB = fixtureId('a', ENTITY.job);
const REPLY = fixtureId('a', ENTITY.autoReply);
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
const ME = 1_000_001;
const CLIENT = 2_000_002;
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let deps: AutoReplyDeps;

const fakeThreads: number[] = [];

/** A project thread in the database and on the stand-in, as the inbox sync would leave it. */
async function thread(externalId: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle)
     values ($1, $2, 'freelancer', $3, 'acme-shop') returning id`,
    [ORG, JOB, String(externalId)],
  );
  fakeThreads.push(externalId);
  fake.setThreads(
    fakeThreads.map((id) => ({
      id,
      context: { type: 'project' as const, id: 15791512 },
      members: [ME, CLIENT],
      owner: CLIENT,
      time_created: 1790150400,
      time_updated: 1790150400,
    })),
  );
  return rows[0]!.id;
}

async function inbound(
  threadId: string,
  sentAt: string,
  body = 'Hi, can you start on Monday?',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'in', $3, $4, 'ext-' || gen_random_uuid()::text, 'platform') returning id`,
    [ORG, threadId, body, sentAt],
  );
  return rows[0]!.id;
}

async function outbound(threadId: string, sentAt: string): Promise<void> {
  await db.query(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'out', 'On it.', $3, 'ext-' || gen_random_uuid()::text, 'platform')`,
    [ORG, threadId, sentAt],
  );
}

async function setLive(orgLive: boolean): Promise<void> {
  await db.query(
    `update settings set live_mode = $2, min_margin_pct = 20, min_margin_zar_minor = 50000,
       fx_buffer_pct = 3, retention_days = 365,
       fee_table = '[{"platform":"freelancer","project_type":"fixed","side":"freelancer","percent":10,"source_url":"https://example.test/fees","read_on":"2026-09-22"}]'::jsonb
     where org_id = $1`,
    [ORG, orgLive],
  );
}

const sendsFor = async (threadId: string) =>
  (await db.query('select 1 from auto_reply_sends where thread_id = $1', [threadId])).rows.length;
const outboundFor = async (threadId: string) =>
  (
    await db.query<{
      body: string;
      sent_at: string | null;
      approved_via: string | null;
      external_message_id: string | null;
    }>(
      `select body, sent_at, approved_via, external_message_id from messages
        where thread_id = $1 and direction = 'out' order by created_at`,
      [threadId],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) {
    if (
      ['memberships', 'platform_accounts', 'jobs', 'auto_replies', 'settings'].includes(row.table)
    ) {
      await db.exec(row.sql);
    }
  }
  await db.query(`update platform_accounts set external_user_id = $2 where id = $1`, [
    ACCOUNT,
    String(ME),
  ]);
  fake = await startFakeFreelancer();
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt: new Date('2026-10-23T10:00:00Z') });
  deps = { db, liveMode: false, config, now: () => NOW };
}, 60_000);

afterAll(async () => {
  await fake.close();
  await db.close();
});

describe('the auto-reply', () => {
  it('is skipped, naming D-08, while none is switched on', async () => {
    const t1 = await thread(5001);
    const m1 = await inbound(t1, '2026-09-23T09:58:00Z');
    const run = await autoReply(deps, { messageId: m1 });
    expect(run).toMatchObject({ status: 'skipped', reason: 'not_configured' });
    expect((run as { message: string }).message).toMatch(/D-08/);
    expect(await sendsFor(t1)).toBe(0);
    const logged = await listEvents(db, { type: 'auto_reply.sent' });
    expect(logged[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('with live mode off, records the reply once with its approval, leaves it unsent, and logs what would have gone', async () => {
    await db.query(
      `update auto_replies set body = 'Thanks, I will reply within a day.', active = true,
              offline_after_minutes = 30, approved_by = $2 where id = $1`,
      [REPLY, OWNER],
    );
    const t1 = (
      await db.query<{ id: string }>(`select id from threads where external_thread_id = '5001'`)
    ).rows[0]!.id;
    const m1 = (
      await db.query<{ id: string }>(`select id from messages where thread_id = $1`, [t1])
    ).rows[0]!.id;
    const run = await autoReply(deps, { messageId: m1 });
    expect(run).toMatchObject({ status: 'blocked', reason: 'live_mode_off' });
    expect((run as { message: string }).message).toMatch(/LIVE_MODE is false/);

    const out = await outboundFor(t1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      body: 'Thanks, I will reply within a day.',
      sent_at: null,
      approved_via: 'auto',
      external_message_id: null,
    });
    expect(await sendsFor(t1)).toBe(1);
    const blocked = await listEvents(db, { type: 'external.blocked_by_live_mode' });
    expect(blocked[0]?.payload).toMatchObject({
      closedBy: 'both',
      // The words are on the message; the log keeps their fingerprint (ARB-520, P-02).
      wouldSend: {
        external_thread_id: '5001',
        message: textFingerprint('Thanks, I will reply within a day.'),
      },
    });
    expect(
      fake.calls.filter((c) => c.method === 'POST' && c.path.includes('/messages/')),
    ).toHaveLength(0);
  });

  it('a second inbound message on the thread never triggers a second auto-reply', async () => {
    const t1 = (
      await db.query<{ id: string }>(`select id from threads where external_thread_id = '5001'`)
    ).rows[0]!.id;
    const m2 = await inbound(t1, '2026-09-23T09:59:00Z', 'Are you there?');
    const run = await autoReply(deps, { messageId: m2 });
    expect(run).toMatchObject({ status: 'skipped', reason: 'already_sent' });
    expect(await sendsFor(t1)).toBe(1);
    expect(await outboundFor(t1)).toHaveLength(1);
    // Run again on the first message too: still one.
    const m1 = (
      await db.query<{ id: string }>(
        `select id from messages where thread_id = $1 and direction = 'in' order by sent_at limit 1`,
        [t1],
      )
    ).rows[0]!.id;
    expect(await autoReply(deps, { messageId: m1 })).toMatchObject({
      status: 'skipped',
      reason: 'already_sent',
    });
    expect(await sendsFor(t1)).toBe(1);
  });

  it('a thread someone has already answered gets none; an outbound message from anywhere in the org counts as online', async () => {
    const t2 = await thread(5002);
    await outbound(t2, '2026-09-23T09:50:00Z');
    const m = await inbound(t2, '2026-09-23T09:59:00Z');
    expect(await autoReply(deps, { messageId: m })).toMatchObject({
      status: 'skipped',
      reason: 'already_replied',
    });

    const t3 = await thread(5003);
    const m3 = await inbound(t3, '2026-09-23T09:59:30Z');
    // The reply on 5002 at 09:50 is ten minutes old; the period is thirty.
    expect(await autoReply(deps, { messageId: m3 })).toMatchObject({
      status: 'skipped',
      reason: 'operator_online',
    });
    expect(await sendsFor(t3)).toBe(0);
    // With a five-minute period the operator is offline, and the reply is recorded (still unsent: live mode off).
    await db.query(`update auto_replies set offline_after_minutes = 5 where id = $1`, [REPLY]);
    expect(await autoReply(deps, { messageId: m3 })).toMatchObject({
      status: 'blocked',
      reason: 'live_mode_off',
    });
    expect(await sendsFor(t3)).toBe(1);
  });

  it('an outbound or closed-thread message gets none', async () => {
    const t4 = await thread(5004);
    const m4 = await inbound(t4, '2026-09-23T09:59:00Z');
    await db.query(`update threads set status = 'closed' where id = $1`, [t4]);
    expect(await autoReply(deps, { messageId: m4 })).toMatchObject({
      status: 'skipped',
      reason: 'thread_closed',
    });
    await db.query(`update threads set status = 'open' where id = $1`, [t4]);
    const { rows } = await db.query<{ id: string }>(
      `insert into messages (org_id, thread_id, direction, body, origin) values ($1, $2, 'out', 'x', 'platform') returning id`,
      [ORG, t4],
    );
    expect(await autoReply(deps, { messageId: rows[0]!.id })).toMatchObject({
      status: 'skipped',
      reason: 'not_inbound',
    });
    await db.query('delete from messages where id = $1', [rows[0]!.id]);
  });

  it('with both switches on, sends through the documented call, records the id and the time, and logs it', async () => {
    await setLive(true);
    const live = { ...deps, liveMode: true };
    const t5 = await thread(5005);
    // Nothing has left the org for the period: the last outbound is 09:50 and the period five minutes.
    const m5 = await inbound(t5, '2026-09-23T09:59:00Z');
    const run = await autoReply(live, { messageId: m5 });
    expect(run).toMatchObject({ status: 'sent' });

    const call = fake.calls
      .filter((c) => c.method === 'POST' && c.path === '/api/messages/0.1/threads/5005/messages/')
      .at(-1)!;
    expect(call.query.message).toBe('Thanks, I will reply within a day.');
    expect(call.headers['freelancer-oauth-v1']).toMatch(/^access-/);
    const out = await outboundFor(t5);
    expect(out).toHaveLength(1);
    expect(out[0]?.sent_at).not.toBeNull();
    expect(out[0]?.external_message_id).toBe(
      (run as { externalMessageId: string }).externalMessageId,
    );
    const status = await db.query<{ status: string }>(
      `select status::text as status from threads where id = $1`,
      [t5],
    );
    expect(status.rows[0]?.status).toBe('awaiting_client');
    const logged = await listEvents(db, { type: 'auto_reply.sent' });
    expect(logged[0]).toMatchObject({ outcome: 'ok' });
    const calls = await listEvents(db, { type: 'external.call' });
    expect(calls[0]?.payload).toMatchObject({ call: 'messages/0.1/threads/{thread_id}/messages' });
    expect(JSON.stringify(calls)).not.toMatch(/access-/);
  });

  it('a platform refusal undoes the record so the queue can try again, and the retry sends once', async () => {
    const live = { ...deps, liveMode: true };
    const t6 = await thread(5006);
    // The last send was moments ago, so widen the period's sense: a fresh org state.
    await db.query(
      `update messages set sent_at = '2026-09-23T09:00:00Z' where direction = 'out' and sent_at is not null`,
    );
    const m6 = await inbound(t6, '2026-09-23T09:59:00Z');
    fake.rateLimitNextCalls(1);
    const error = await autoReply(live, { messageId: m6 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    expect((error as FreelancerError).status).toBe(429);
    expect(await sendsFor(t6)).toBe(0);
    expect(await outboundFor(t6)).toHaveLength(0);
    const refused = (await listEvents(db, { type: 'external.call' })).find(
      (e) => e.outcome === 'error',
    );
    expect(refused?.payload).toMatchObject({ status: 429 });

    expect(await autoReply(live, { messageId: m6 })).toMatchObject({ status: 'sent' });
    expect(await sendsFor(t6)).toBe(1);
    expect(
      fake.calls.filter(
        (c) => c.method === 'POST' && c.path === '/api/messages/0.1/threads/5006/messages/',
      ),
    ).toHaveLength(2);
  });
});
