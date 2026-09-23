import { listEvents } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-122 acceptance: "No message leaves without approval event". The API drafts,
 * approves, edits and rejects; the database refuses a sent app message without its
 * approval (0003), shown here directly.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
let db: PGlite;
let app: FastifyInstance;
let thread: string;
let draft: string;
const enqueued: { messageId: string; requestId?: string }[] = [];

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email, full_name) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test', 'Person ${tag.toUpperCase()}')`);
    await db.exec(
      `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`,
    );
  }
  await db.query(`update users set full_name = 'Ayanda Nkosi' where id = $1`, [USER_A]);
  await db.query(
    `insert into jobs (id, org_id, platform, external_id, raw, title) values ($1, $2, 'freelancer', '15791512', '{}'::jsonb, 'Shopify store rebuild')`,
    [JOB, ORG_A],
  );
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle, status)
     values ($1, $2, 'freelancer', '5001', 'acme-shop', 'awaiting_operator') returning id`,
    [ORG_A, JOB],
  );
  thread = t.rows[0]!.id;
  await db.query(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'in', 'Hi, can you start on Monday?', '2026-09-23T09:58:00Z', '9001', 'platform')`,
    [ORG_A, thread],
  );
  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => new Date('2026-09-23T10:00:00Z'),
    enqueue: {
      sendMessage: (data) => {
        enqueued.push(data);
        return Promise.resolve();
      },
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('drafting a reply', () => {
  it('an owner drafts a reply on the thread; it waits, unsent and unapproved, with the last client message beside it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/messages`,
      headers: as(AUTH_A),
      payload: { body: '  Yes, Monday works. I will send a plan today.  ' },
    });
    expect(created.statusCode).toBe(201);
    const message = created.json().message;
    draft = message.id;
    expect(message).toMatchObject({
      threadId: thread,
      externalThreadId: '5001',
      clientHandle: 'acme-shop',
      jobTitle: 'Shopify store rebuild',
      body: 'Yes, Monday works. I will send a plan today.',
      state: 'queued',
      approvedBy: null,
      sentAt: null,
      lastInbound: { body: 'Hi, can you start on Monday?' },
    });
    const events = await listEvents(db, { type: 'message.drafted' });
    expect(events[0]).toMatchObject({ org_id: ORG_A, actor_user_id: USER_A, subject_id: draft });
  });

  it('refuses an empty draft, a viewer, and another org’s thread', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/threads/${thread}/messages`,
          headers: as(AUTH_A),
          payload: { body: ' ' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/threads/${thread}/messages`,
          headers: as(AUTH_VIEWER),
          payload: { body: 'Hi' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/threads/${thread}/messages`,
          headers: as(AUTH_B),
          payload: { body: 'Hi' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('the database refuses to mark an unapproved app message sent, whoever tries', async () => {
    await expect(
      db.query(`update messages set sent_at = now() where id = $1`, [draft]),
    ).rejects.toThrow(/outbound_requires_approval/);
  });
});

describe('approving, editing and rejecting', () => {
  it('a viewer cannot approve; the operator can, is named, and the sender is handed the message', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/outbound-messages/${draft}/approve`,
          headers: as(AUTH_VIEWER),
        })
      ).statusCode,
    ).toBe(403);
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/outbound-messages/${draft}/approve`,
      headers: as(AUTH_OPERATOR),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      message: { state: 'approved', approvedByName: 'Person D', approvedVia: 'web', sentAt: null },
      queued: true,
    });
    expect(enqueued).toEqual([{ messageId: draft, requestId: expect.any(String) }]);
    const events = await listEvents(db, { type: 'message.approved' });
    expect(events[0]).toMatchObject({
      subject_id: draft,
      actor_user_id: fixtureId('d', ENTITY.user),
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/outbound-messages/${draft}/approve`,
      headers: as(AUTH_A),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('This message is already approved, so it cannot be approved.');
  });

  it('the list shows each state; the filter defaults to what is waiting', async () => {
    const waiting = await app.inject({
      method: 'GET',
      url: '/v1/outbound-messages',
      headers: as(AUTH_A),
    });
    expect(waiting.json().messages).toEqual([]);
    const approved = await app.inject({
      method: 'GET',
      url: '/v1/outbound-messages?status=approved',
      headers: as(AUTH_A),
    });
    expect(approved.json().messages.map((m: { id: string }) => m.id)).toEqual([draft]);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/outbound-messages?status=all',
      headers: as(AUTH_B),
    });
    expect(other.json().messages).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/outbound-messages?status=nope',
          headers: as(AUTH_A),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('an edit clears the approval; the new words wait again', async () => {
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/outbound-messages/${draft}`,
      headers: as(AUTH_A),
      payload: { body: 'Yes, Monday works.' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().message).toMatchObject({
      body: 'Yes, Monday works.',
      state: 'queued',
      approvedBy: null,
    });
    expect((await listEvents(db, { type: 'message.edited' }))[0]).toMatchObject({
      subject_id: draft,
    });
  });

  it('a rejection records its reason and can be undone by an edit; a sent message cannot be changed', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/outbound-messages/${draft}/reject`,
          headers: as(AUTH_A),
          payload: { reason: '' },
        })
      ).statusCode,
    ).toBe(422);
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/outbound-messages/${draft}/reject`,
      headers: as(AUTH_A),
      payload: { reason: 'Too vague' },
    });
    expect(rejected.json().message).toMatchObject({
      state: 'rejected',
      failureReason: 'Too vague',
      rejectedAt: '2026-09-23T10:00:00.000Z',
    });
    expect((await listEvents(db, { type: 'message.rejected' }))[0]?.payload).toMatchObject({
      reason: 'Too vague',
      state_before: 'queued',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/outbound-messages/${draft}/approve`,
          headers: as(AUTH_A),
        })
      ).statusCode,
    ).toBe(409);
    const revived = await app.inject({
      method: 'PATCH',
      url: `/v1/outbound-messages/${draft}`,
      headers: as(AUTH_A),
      payload: { body: 'Yes, Monday works. Plan attached.' },
    });
    expect(revived.json().message).toMatchObject({
      state: 'queued',
      rejectedAt: null,
      failureReason: null,
    });

    // As the worker would leave it once sent: approved, then sent.
    await db.query(`update messages set approved_by = $2, approved_via = 'web' where id = $1`, [
      draft,
      USER_A,
    ]);
    await db.query(
      `update messages set sent_at = now(), external_message_id = '9009' where id = $1`,
      [draft],
    );
    for (const [method, url, payload] of [
      ['PATCH', `/v1/outbound-messages/${draft}`, { body: 'x' }],
      ['POST', `/v1/outbound-messages/${draft}/reject`, { reason: 'late' }],
      ['POST', `/v1/outbound-messages/${draft}/approve`, undefined],
    ] as const) {
      const refused = await app.inject({
        method,
        url,
        headers: as(AUTH_A),
        ...(payload ? { payload } : {}),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('This message has already been sent.');
    }
    const sent = await app.inject({
      method: 'GET',
      url: '/v1/outbound-messages?status=sent',
      headers: as(AUTH_A),
    });
    expect(sent.json().messages[0]).toMatchObject({
      id: draft,
      state: 'sent',
      externalMessageId: '9009',
    });
  });
});
