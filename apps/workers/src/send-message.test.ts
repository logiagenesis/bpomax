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
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage, type SendMessageDeps } from './send-message.js';

/**
 * ARB-122 acceptance: "No message leaves without approval event (test)". Real Postgres
 * (PGlite) for the rows and 0003's constraint, the stand-in of Freelancer.com over HTTP
 * for the sends live mode lets through.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const JOB = fixtureId('a', ENTITY.job);
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
const ME = 1_000_001;
const CLIENT = 2_000_002;
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let deps: SendMessageDeps;
let thread: string;

async function draft(body = 'Yes, Monday works.'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, origin) values ($1, $2, 'out', $3, 'app') returning id`,
    [ORG, thread, body],
  );
  return rows[0]!.id;
}
async function approve(id: string): Promise<void> {
  await db.query(`update messages set approved_by = $2, approved_via = 'web' where id = $1`, [
    id,
    OWNER,
  ]);
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
const row = async (id: string) =>
  (
    await db.query<{
      sent_at: string | null;
      external_message_id: string | null;
      failure_reason: string | null;
    }>('select sent_at, external_message_id, failure_reason from messages where id = $1', [id])
  ).rows[0]!;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) {
    if (['memberships', 'platform_accounts', 'jobs', 'settings'].includes(row.table))
      await db.exec(row.sql);
  }
  await db.query(`update platform_accounts set external_user_id = $2 where id = $1`, [
    ACCOUNT,
    String(ME),
  ]);
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle, status)
     values ($1, $2, 'freelancer', '5001', 'acme-shop', 'awaiting_operator') returning id`,
    [ORG, JOB],
  );
  thread = t.rows[0]!.id;
  fake = await startFakeFreelancer();
  fake.setThreads([
    {
      id: 5001,
      context: { type: 'project', id: 15791512 },
      members: [ME, CLIENT],
      owner: CLIENT,
      time_created: 1790150400,
      time_updated: 1790150400,
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
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt: new Date('2026-10-23T10:00:00Z') });
  deps = { db, liveMode: false, config, now: () => NOW };
}, 60_000);

afterAll(async () => {
  await fake.close();
  await db.close();
});

const posts = () =>
  fake.calls.filter(
    (c) => c.method === 'POST' && c.path === '/api/messages/0.1/threads/5001/messages/',
  );

describe('sending an approved message', () => {
  it('an unapproved message is never sent, by the worker or by the database', async () => {
    const id = await draft();
    expect(await sendMessage(deps, { messageId: id })).toMatchObject({
      status: 'skipped',
      reason: 'not_approved',
    });
    await expect(
      db.query(`update messages set sent_at = now() where id = $1`, [id]),
    ).rejects.toThrow(/outbound_requires_approval/);
    expect(posts()).toHaveLength(0);
    expect((await listEvents(db, { type: 'message.sent' }))[0]).toMatchObject({
      outcome: 'skipped',
      subject_id: id,
    });
    await db.query('delete from messages where id = $1', [id]);
  });

  it('with live mode off, an approved message stays unsent and what would have gone is in the audit log', async () => {
    const id = await draft();
    await approve(id);
    const run = await sendMessage(deps, { messageId: id });
    expect(run).toMatchObject({ status: 'blocked', reason: 'live_mode_off' });
    expect((run as { message: string }).message).toMatch(/^Not sent: LIVE_MODE is false/);
    expect(await row(id)).toMatchObject({ sent_at: null, external_message_id: null });
    const blocked = await listEvents(db, { type: 'external.blocked_by_live_mode' });
    expect(blocked[0]).toMatchObject({ subject_id: id });
    expect(blocked[0]?.payload).toMatchObject({
      closedBy: 'both',
      // The words are on the message; the log keeps their fingerprint (ARB-520, P-02).
      wouldSend: { external_thread_id: '5001', message: textFingerprint('Yes, Monday works.') },
    });
    expect(posts()).toHaveLength(0);
    await db.query('delete from messages where id = $1', [id]);
  });

  it('a rejected message is skipped', async () => {
    const id = await draft();
    await db.query(`update messages set rejected_at = now(), failure_reason = 'no' where id = $1`, [
      id,
    ]);
    expect(await sendMessage(deps, { messageId: id })).toMatchObject({
      status: 'skipped',
      reason: 'rejected',
    });
    await db.query('delete from messages where id = $1', [id]);
  });

  it('with both switches on, sends with the documented call, records the id and the time, and moves the thread', async () => {
    await setLive(true);
    const live = { ...deps, liveMode: true };
    const id = await draft('Yes, Monday works. Plan attached.');
    await approve(id);
    const run = await sendMessage(live, { messageId: id });
    expect(run).toMatchObject({ status: 'sent' });
    const call = posts().at(-1)!;
    expect(call.query.message).toBe('Yes, Monday works. Plan attached.');
    expect(call.headers['freelancer-oauth-v1']).toMatch(/^access-/);
    const stored = await row(id);
    expect(stored.sent_at).not.toBeNull();
    expect(stored.external_message_id).toBe(
      (run as { externalMessageId: string }).externalMessageId,
    );
    const status = await db.query<{ status: string }>(
      `select status::text as status from threads where id = $1`,
      [thread],
    );
    expect(status.rows[0]?.status).toBe('awaiting_client');
    const sent = await listEvents(db, { type: 'message.sent' });
    expect(sent[0]).toMatchObject({ outcome: 'ok', subject_id: id });
    const calls = await listEvents(db, { type: 'external.call' });
    expect(calls[0]?.payload).toMatchObject({ call: 'messages/0.1/threads/{thread_id}/messages' });
    expect(JSON.stringify(calls)).not.toMatch(/access-/);
    // Sending again does nothing: it is already sent.
    expect(await sendMessage(live, { messageId: id })).toMatchObject({ status: 'already_sent' });
    expect(posts()).toHaveLength(1);
  });

  it('a rate limit goes back to the queue and the retry sends; a refused token is final and recorded on the row', async () => {
    const live = { ...deps, liveMode: true };
    const id = await draft('Second reply.');
    await approve(id);
    fake.rateLimitNextCalls(1);
    const error = await sendMessage(live, { messageId: id }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    expect(await row(id)).toMatchObject({ sent_at: null, failure_reason: null });
    expect(await sendMessage(live, { messageId: id })).toMatchObject({ status: 'sent' });

    const third = await draft('Third reply.');
    await approve(third);
    fake.expireAccessTokens();
    const refused = await sendMessage(live, { messageId: third }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnrecoverableError);
    const stored = await row(third);
    expect(stored.sent_at).toBeNull();
    expect(stored.failure_reason).toMatch(/Edit the message and approve it again/);
    expect((await listEvents(db, { type: 'message.sent' }))[0]).toMatchObject({
      outcome: 'error',
      subject_id: third,
    });
  });
});
