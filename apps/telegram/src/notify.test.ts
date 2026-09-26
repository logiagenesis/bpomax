import { randomUUID } from 'node:crypto';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import {
  closeQueues,
  createQueues,
  queueNotifier,
  redisConnection,
  startWorker,
  type QueueSet,
} from '@arbitron/workers';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TelegramApi } from './api.js';
import { notifyProcessor } from './notify.js';

/**
 * ARB-510 (D-075): the workers queue a Telegram notice and the bot process sends it, over
 * a real Redis, so the bot token lives in the bot process alone. The notices are the
 * ones the workers raise: an inbound client message (ARB-120), a reprice breach
 * (ARB-204) and a usage alert's text (ARB-410).
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const THREAD = fixtureId('a', ENTITY.thread);
const OWNER_CHAT = '2001';
const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const prefix = `notify-${randomUUID()}`;

class ScriptedTelegram implements TelegramApi {
  readonly sent: { chatId: string; text: string }[] = [];
  sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
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

let db: PGlite;
let queues: QueueSet;
let worker: Worker;
let events: QueueEvents;
const api = new ScriptedTelegram();

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.query('update users set telegram_chat_id = $2 where id = $1', [OWNER, OWNER_CHAT]);

  queues = createQueues({ connection, prefix });
  events = new QueueEvents('notify', { connection, prefix });
  await events.waitUntilReady();
  worker = startWorker('notify', notifyProcessor({ db, api }), {
    connection,
    prefix,
    deadLetter: queues['dead-letter'],
  });
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await db.close();
});

describe('notices queued by the workers are sent by the bot', () => {
  it('sends a usage alert text to the chat it names', async () => {
    const job = await queueNotifier(queues.notify).text(OWNER_CHAT, 'Plan at 80%');
    expect(await job.waitUntilFinished(events, 15_000)).toBe(1);
    expect(api.sent).toContainEqual({ chatId: OWNER_CHAT, text: 'Plan at 80%' });
  });

  it("sends an inbound message's card to the org's linked owner", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
       values ($1, $2, 'in', 'Can you start on Monday?', now(), 'ext-' || gen_random_uuid()::text, 'platform')
       returning id`,
      [ORG, THREAD],
    );
    const before = api.sent.length;
    const job = await queueNotifier(queues.notify).inbound({
      orgId: ORG,
      messageId: rows[0]!.id,
      threadId: THREAD,
    });
    expect(await job.waitUntilFinished(events, 15_000)).toBe(1);
    const card = api.sent.slice(before);
    expect(card).toHaveLength(1);
    expect(card[0]?.chatId).toBe(OWNER_CHAT);
    expect(card[0]?.text).toContain('Can you start on Monday?');
  });

  it("pushes a new bid's approval card to the approvers", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status)
       values ($1, $2, 'A new bid to approve.', 150000, 'ZAR', 7, 'queued') returning id`,
      [ORG, fixtureId('a', ENTITY.job)],
    );
    const before = api.sent.length;
    const job = await queueNotifier(queues.notify).queued(rows[0]!.id);
    expect(await job.waitUntilFinished(events, 15_000)).toBe(1);
    const card = api.sent.slice(before);
    expect(card).toHaveLength(1);
    expect(card[0]?.chatId).toBe(OWNER_CHAT);
    expect(card[0]?.text).toContain('A new bid to approve.');
  });

  it('sends nothing for a reprice whose evaluation is gone, and does not fail', async () => {
    const before = api.sent.length;
    const job = await queueNotifier(queues.notify).reprice({
      orgId: ORG,
      candidateId: randomUUID(),
      evaluationId: randomUUID(),
    });
    expect(await job.waitUntilFinished(events, 15_000)).toBe(0);
    expect(api.sent.length).toBe(before);
  });
});
