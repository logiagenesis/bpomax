import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TelegramApi } from './api.js';
import type { BotDeps } from './engine.js';
import { inboundAlert, notifyInbound, renderInbound } from './inbox.js';

/**
 * ARB-120: "alerts Telegram". The message row is what the inbox-sync worker leaves; the
 * card goes to every linked owner or operator chat in the org, and to nobody else.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const VIEWER = fixtureId('b', ENTITY.user);
const THREAD = fixtureId('a', ENTITY.thread);
const JOB = fixtureId('a', ENTITY.job);
const OWNER_CHAT = '1001';
const VIEWER_CHAT = '1002';
let db: PGlite;

class ScriptedTelegram implements TelegramApi {
  readonly sent: { chatId: string; text: string; buttons?: unknown }[] = [];
  sendMessage(chatId: string, text: string, buttons?: unknown) {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
    return Promise.resolve({ messageId: this.sent.length });
  }
  answerCallbackQuery() {
    return Promise.resolve();
  }
  editMessageReplyMarkup() {
    return Promise.resolve();
  }
  setWebhook() {
    return Promise.resolve();
  }
  getMe() {
    return Promise.resolve({ id: 1, username: 'arbitron_test_bot' });
  }
}

const api = new ScriptedTelegram();
const deps = (): BotDeps => ({ db, api });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.query(`update users set telegram_chat_id = $2 where id = $1`, [OWNER, OWNER_CHAT]);
  await db.query(`update users set telegram_chat_id = $2 where id = $1`, [VIEWER, VIEWER_CHAT]);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [
    ORG,
    VIEWER,
  ]);
  await db.query(`update threads set client_handle = 'acme-shop', job_id = $2 where id = $1`, [
    THREAD,
    JOB,
  ]);
  await db.query(`update jobs set title = 'Shopify store rebuild' where id = $1`, [JOB]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function inbound(body: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'in', $3, '2026-09-23T08:01:00Z', 'ext-' || gen_random_uuid()::text, 'platform')
     returning id`,
    [ORG, THREAD, body],
  );
  return rows[0]!.id;
}

describe('notifyInbound', () => {
  it('sends the card to the linked owner, not the viewer, with the client, the job and the text', async () => {
    const messageId = await inbound('Hi, can you start on Monday?');
    expect(await notifyInbound(deps(), { orgId: ORG, messageId, threadId: THREAD })).toBe(1);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ chatId: OWNER_CHAT });
    expect(api.sent[0]?.buttons).toBeUndefined();
    expect(api.sent[0]?.text).toBe(
      [
        'New client message',
        'From: acme-shop',
        'About: Shopify store rebuild',
        '',
        'Hi, can you start on Monday?',
      ].join('\n'),
    );
  });

  it('an outbound or unknown message sends nothing', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into messages (org_id, thread_id, direction, body, origin) values ($1, $2, 'out', 'Yes', 'platform') returning id`,
      [ORG, THREAD],
    );
    expect(
      await notifyInbound(deps(), { orgId: ORG, messageId: rows[0]!.id, threadId: THREAD }),
    ).toBe(0);
    expect(
      await notifyInbound(deps(), {
        orgId: ORG,
        messageId: fixtureId('f', ENTITY.message),
        threadId: THREAD,
      }),
    ).toBe(0);
    expect(api.sent).toHaveLength(1);
  });

  it('a long message is cut at 400 characters; a thread without a job or a handle says so', () => {
    const text = renderInbound({
      clientHandle: null,
      jobTitle: null,
      body: 'x'.repeat(500),
      sentAt: null,
    });
    expect(text).toContain('From: the client');
    expect(text).toContain('About: no linked job');
    expect(text.split('\n').at(-1)?.length).toBe(400);
    expect(renderInbound({ clientHandle: 'a', jobTitle: 'b', body: '', sentAt: null })).toContain(
      '(no text)',
    );
  });

  it('inboundAlert is the worker’s dependency, bound to the bot', async () => {
    const messageId = await inbound('Second message');
    const alert = inboundAlert(deps());
    expect(await alert({ orgId: ORG, messageId, threadId: THREAD })).toBe(1);
    expect(api.sent).toHaveLength(2);
  });
});
