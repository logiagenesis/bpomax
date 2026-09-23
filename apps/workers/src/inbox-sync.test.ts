import { randomUUID } from 'node:crypto';
import { listEvents, putPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { exchangeCode, freelancerConfig, type FreelancerConfig } from '@arbitron/freelancer';
import { startFakeFreelancer, type FakeFreelancer } from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INBOX_POLL_EVERY_MS,
  INBOX_SYNC_SCHEDULER_ID,
  accountSchedulerId,
  inboxProcessor,
  messageBody,
  pollInbox,
  scheduleInboxSync,
  syncInboxSchedules,
  type InboundAlert,
  type InboxDeps,
  type InboxRun,
} from './inbox-sync.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-120: "New sandbox message appears in app within one interval and alerts Telegram".
 * Real Redis for the schedules and the worker, real Postgres (PGlite) for the rows, and
 * the stand-in of Freelancer.com over HTTP for the threads and messages. The Telegram
 * side is the `alert` dependency, recorded here; its card is apps/telegram's test.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const ACCOUNT_A = fixtureId('a', ENTITY.platformAccount);
const ACCOUNT_B = fixtureId('b', ENTITY.platformAccount);
const JOB_A = fixtureId('a', ENTITY.job);
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
const T0 = Math.floor(Date.parse('2026-09-23T08:00:00Z') / 1000);
/** The stand-in's default user is the account; 2000002 is the client. */
const ME = 1_000_001;
const CLIENT = 2_000_002;

const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const prefix = `arb-test-${randomUUID()}`;
const queues = createQueues({ connection, prefix, attempts: 2, backoffMs: 10 });
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let deps: InboxDeps;
let worker: Worker;
let events: QueueEvents;
const alerts: InboundAlert[] = [];

async function connect(accountId: string): Promise<void> {
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [accountId]);
  await putPlatformTokens(db, accountId, {
    ...tokens,
    expiresAt: new Date('2026-10-23T10:00:00Z'),
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const rows of [tenantRows(ORG_A, 'a', 'a'), tenantRows(ORG_B, 'b', 'b')]) {
    for (const row of rows) {
      if (['memberships', 'platform_accounts', 'jobs'].includes(row.table)) await db.exec(row.sql);
    }
  }
  await db.query(`update platform_accounts set external_user_id = $2 where id = $1`, [
    ACCOUNT_A,
    String(ME),
  ]);
  await db.query(`update platform_accounts set status = 'disconnected' where id = $1`, [ACCOUNT_B]);
  await db.query(
    `update jobs set external_id = '15791512', title = 'Shopify store rebuild' where id = $1`,
    [JOB_A],
  );

  fake = await startFakeFreelancer();
  fake.setMembers([
    { id: ME, username: 'sandbox-freelancer' },
    { id: CLIENT, username: 'acme-shop', display_name: 'Acme Shop' },
  ]);
  fake.setThreads([
    {
      id: 5001,
      context: { type: 'project', id: 15791512 },
      members: [ME, CLIENT],
      owner: CLIENT,
      time_created: T0,
      time_updated: T0 + 600,
    },
    // A contest thread: not asked for (context_type=project), so never stored.
    {
      id: 5002,
      context: { type: 'contest', id: 77 },
      members: [ME, CLIENT],
      owner: CLIENT,
      time_created: T0,
      time_updated: T0 + 700,
    },
    // Someone else's thread: the stand-in never returns it, as the API would not.
    {
      id: 5003,
      context: { type: 'project', id: 15791512 },
      members: [CLIENT, 3_000_003],
      owner: CLIENT,
      time_created: T0,
      time_updated: T0 + 800,
    },
  ]);
  fake.setMessages([
    {
      id: 9001,
      thread_id: 5001,
      from_user: CLIENT,
      message: 'Hi, can you start on Monday?',
      time_created: T0 + 60,
    },
    {
      id: 9002,
      thread_id: 5001,
      from_user: ME,
      message: 'Yes, Monday works.',
      time_created: T0 + 600,
    },
    {
      id: 9003,
      thread_id: 5002,
      from_user: CLIENT,
      message: 'Contest chat',
      time_created: T0 + 700,
    },
  ]);
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  await connect(ACCOUNT_A);

  deps = {
    db,
    queue: queues['inbox-sync'],
    config,
    now: () => NOW,
    alert: (alert) => {
      alerts.push(alert);
      return Promise.resolve(1);
    },
  };
  worker = startWorker('inbox-sync', inboxProcessor(deps), {
    connection,
    prefix,
    deadLetter: queues[DEAD_LETTER_QUEUE],
  });
  events = new QueueEvents('inbox-sync', { connection, prefix });
  await events.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await fake.close();
  await db.close();
});

const calls = (path: string) => fake.calls.filter((c) => c.path === path);

describe('the schedules', () => {
  beforeAll(() => queues['inbox-sync'].pause());
  afterAll(async () => {
    await queues['inbox-sync'].drain(true);
    await queues['inbox-sync'].resume();
  });

  it('one sync scheduler every minute, and one poll per connected account every two minutes', async () => {
    await scheduleInboxSync(queues['inbox-sync']);
    await scheduleInboxSync(queues['inbox-sync']);
    expect(await syncInboxSchedules(deps)).toEqual({ wanted: 1, added: 1, removed: 0 });
    const schedulers = await queues['inbox-sync'].getJobSchedulers();
    expect(schedulers.map((s) => [s.key, String(s.every)]).sort()).toEqual([
      [INBOX_SYNC_SCHEDULER_ID, '60000'],
      [accountSchedulerId(ACCOUNT_A), String(INBOX_POLL_EVERY_MS)],
    ]);
    // A disconnected account's schedule goes; a reconnected one comes back.
    await db.query(`update platform_accounts set status = 'expired' where id = $1`, [ACCOUNT_A]);
    expect(await syncInboxSchedules(deps)).toEqual({ wanted: 0, added: 0, removed: 1 });
    await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT_A]);
    expect(await syncInboxSchedules(deps)).toEqual({ wanted: 1, added: 1, removed: 0 });
    expect((await syncInboxSchedules({ ...deps, config: null })).reason).toMatch(/B-03/);
    for (const s of await queues['inbox-sync'].getJobSchedulers()) {
      await queues['inbox-sync'].removeJobScheduler(s.key);
    }
  });
});

describe('a poll', () => {
  it('stores the account’s project threads and messages, links the job, names the client, logs and alerts each inbound message', async () => {
    const run = await pollInbox(deps, { accountId: ACCOUNT_A, requestId: 'req-1' });
    expect(run).toMatchObject({
      status: 'polled',
      orgId: ORG_A,
      threads: 1,
      newThreads: 1,
      messages: 2,
      newInbound: 1,
      newOutbound: 1,
      syncedTo: new Date((T0 + 600) * 1000).toISOString(),
    });

    const threadCall = calls('/api/messages/0.1/threads/').at(-1)!;
    expect(threadCall.headers['freelancer-oauth-v1']).toMatch(/^access-/);
    expect(threadCall.query).toMatchObject({
      context_type: 'project',
      user_details: 'true',
      context_details: 'true',
      limit: '100',
    });
    expect(threadCall.query).not.toHaveProperty('from_updated_time');
    const messageCall = calls('/api/messages/0.1/messages/').at(-1)!;
    expect(messageCall.queryAll['threads[]']).toEqual(['5001']);

    const threads = await db.query<{
      id: string;
      job_id: string;
      external_thread_id: string;
      client_handle: string;
      status: string;
      last_message_at: string;
    }>(
      `select id, job_id, external_thread_id, client_handle, status::text as status, last_message_at
         from threads where org_id = $1 order by external_thread_id`,
      [ORG_A],
    );
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0]).toMatchObject({
      job_id: JOB_A,
      external_thread_id: '5001',
      client_handle: 'acme-shop',
      // The newest message is the account's own reply, so the client's turn.
      status: 'awaiting_client',
    });
    expect(new Date(threads.rows[0]!.last_message_at).toISOString()).toBe(
      new Date((T0 + 600) * 1000).toISOString(),
    );

    const messages = await db.query<{
      direction: string;
      body: string;
      sent_at: string;
      external_message_id: string;
      origin: string;
      approved_by: string | null;
    }>(
      `select direction::text as direction, body, sent_at, external_message_id, origin, approved_by
         from messages where thread_id = $1 order by sent_at`,
      [threads.rows[0]!.id],
    );
    expect(
      messages.rows.map((m) => [m.direction, m.body, m.external_message_id, m.origin]),
    ).toEqual([
      ['in', 'Hi, can you start on Monday?', '9001', 'platform'],
      ['out', 'Yes, Monday works.', '9002', 'platform'],
    ]);
    expect(messages.rows[1]?.approved_by).toBeNull();

    const received = await listEvents(db, { type: 'message.received' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ org_id: ORG_A, outcome: 'ok', request_id: 'req-1' });
    expect(received[0]?.payload).toMatchObject({
      external_thread_id: '5001',
      external_message_id: '9001',
      from_user: String(CLIENT),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orgId: ORG_A, threadId: threads.rows[0]!.id });
    const synced = await listEvents(db, { type: 'inbox.synced' });
    expect(synced[0]?.payload).toMatchObject({ new_inbound: 1, new_outbound: 1, new_threads: 1 });
    const external = await listEvents(db, { type: 'external.call' });
    expect(external.map((e) => (e.payload as { call: string }).call).sort()).toEqual([
      'messages/0.1/messages',
      'messages/0.1/threads',
    ]);
    expect(JSON.stringify(external)).not.toMatch(/access-/);
    const account = await db.query<{ inbox_synced_to: string }>(
      'select inbox_synced_to from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(new Date(account.rows[0]!.inbox_synced_to).toISOString()).toBe(
      new Date((T0 + 600) * 1000).toISOString(),
    );
  });

  it('a second poll asks from five minutes before the last point, stores nothing twice and alerts nobody', async () => {
    const run = await pollInbox(deps, { accountId: ACCOUNT_A });
    expect(run).toMatchObject({ status: 'polled', newThreads: 0, newInbound: 0, newOutbound: 0 });
    const threadCall = calls('/api/messages/0.1/threads/').at(-1)!;
    expect(threadCall.query.from_updated_time).toBe(String(T0 + 600 - 300));
    const count = await db.query<{ n: number }>(
      'select count(*)::int as n from messages where org_id = $1',
      [ORG_A],
    );
    expect(count.rows[0]?.n).toBe(2);
    expect(alerts).toHaveLength(1);
  });

  it('a new client message appears within one interval, through the queue, and alerts once', async () => {
    fake.addMessage({
      id: 9004,
      thread_id: 5001,
      from_user: CLIENT,
      message: null,
      attachments: [{ filename: 'brief.pdf' }],
      time_created: T0 + 900,
    });
    const job = await queues['inbox-sync'].add('poll', { kind: 'poll', accountId: ACCOUNT_A });
    const run = (await job.waitUntilFinished(events, 30_000)) as InboxRun;
    expect(run).toMatchObject({ status: 'polled', newInbound: 1, newOutbound: 0 });
    const thread = await db.query<{ status: string }>(
      `select status::text as status from threads where external_thread_id = '5001'`,
    );
    expect(thread.rows[0]?.status).toBe('awaiting_operator');
    const latest = await db.query<{ body: string }>(
      `select body from messages where external_message_id = '9004'`,
    );
    expect(latest.rows[0]?.body).toBe('(1 attachment, not downloaded)');
    expect(alerts).toHaveLength(2);
    expect(messageBody({ message: '  ', attachmentCount: 0 } as never)).toBe('');
  });

  it('an account that is not connected is skipped, saying so, and its schedule removed', async () => {
    await queues['inbox-sync'].upsertJobScheduler(
      accountSchedulerId(ACCOUNT_B),
      { every: 60_000 },
      {
        name: 'poll',
        data: { kind: 'poll', accountId: ACCOUNT_B },
      },
    );
    const run = await pollInbox(deps, { accountId: ACCOUNT_B });
    expect(run).toMatchObject({ status: 'skipped' });
    expect((run as { reason: string }).reason).toMatch(/disconnected/);
    expect(
      (await queues['inbox-sync'].getJobSchedulers()).some(
        (s) => s.key === accountSchedulerId(ACCOUNT_B),
      ),
    ).toBe(false);
  });

  it('a rate limit is logged and the job goes back to the queue, which tries again', async () => {
    const before = (await listEvents(db, { type: 'external.call' })).length;
    fake.rateLimitNextCalls(1);
    const job = await queues['inbox-sync'].add('poll', { kind: 'poll', accountId: ACCOUNT_A });
    const run = (await job.waitUntilFinished(events, 30_000)) as InboxRun;
    expect(run).toMatchObject({ status: 'polled', newInbound: 0 });
    const external = await listEvents(db, { type: 'external.call' });
    // The refused call, then the two calls of the attempt that worked.
    expect(external.length).toBe(before + 3);
    const refused = external.find((e) => e.outcome === 'error');
    expect(refused?.payload).toMatchObject({
      status: 429,
      error_code: 'AuthorisationExceptionCodes.RATE_LIMITED',
    });
    expect(await queues[DEAD_LETTER_QUEUE].count()).toBe(0);
  });

  it('a refused token marks the account expired and is not tried again', async () => {
    fake.expireAccessTokens();
    const run = await pollInbox(deps, { accountId: ACCOUNT_A });
    expect(run).toMatchObject({ status: 'auth_failed', orgId: ORG_A });
    const account = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(account.rows[0]?.status).toBe('expired');
    expect(await pollInbox(deps, { accountId: ACCOUNT_A })).toMatchObject({ status: 'skipped' });
  });
});
