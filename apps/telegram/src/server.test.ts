import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TelegramApi } from './api.js';
import { SECRET_HEADER, WEBHOOK_PATH, buildTelegramServer, secretMatches } from './server.js';

/** ARB-050: the webhook accepts Telegram's updates and nobody else's. */
let db: PGlite;
let app: FastifyInstance;
const sent: string[] = [];
let failNext = false;

const api: TelegramApi = {
  sendMessage(_chatId, text) {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('Telegram down'));
    }
    sent.push(text);
    return Promise.resolve({ messageId: 1 });
  },
  answerCallbackQuery: () => Promise.resolve(),
  editMessageReplyMarkup: () => Promise.resolve(),
  setWebhook: () => Promise.resolve(),
  getMe: () => Promise.resolve({ id: 1, username: 'bot' }),
};

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(fixtureId('a', ENTITY.org), 'a', 'a')) await db.exec(row.sql);
  app = buildTelegramServer({ db, api, webhookSecret: 'shh_1' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

const update = {
  update_id: 1,
  message: { message_id: 1, chat: { id: 5 }, from: { id: 5 }, text: '/queue' },
};

describe(`POST ${WEBHOOK_PATH}`, () => {
  it('refuses an update without Telegram s secret header', async () => {
    expect(
      (await app.inject({ method: 'POST', url: WEBHOOK_PATH, payload: update })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: WEBHOOK_PATH,
          payload: update,
          headers: { [SECRET_HEADER]: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(sent).toEqual([]);
  });

  it('handles an update with the right secret, and answers 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      payload: update,
      headers: { [SECRET_HEADER]: 'shh_1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sent[0]).toMatch(/not linked/);
  });

  it('answers 200 to an update it ignores, and to one the bot could not handle', async () => {
    const ignored = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      payload: { update_id: 2, edited_message: { message_id: 1, chat: { id: 5 }, text: 'x' } },
      headers: { [SECRET_HEADER]: 'shh_1' },
    });
    expect(ignored.statusCode).toBe(200);
    failNext = true;
    const failed = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      payload: update,
      headers: { [SECRET_HEADER]: 'shh_1' },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ ok: false });
  });

  it('compares the secret in constant time, whatever length is sent (the owner audit, S-08)', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8'),
    );
    expect(source).toMatch(/timingSafeEqual/);
    expect(source).not.toMatch(/\[SECRET_HEADER\] !==/);
    expect(secretMatches('shh_1', 'shh_1')).toBe(true);
    expect(secretMatches('shh_2', 'shh_1')).toBe(false);
    expect(secretMatches('shh', 'shh_1')).toBe(false);
    expect(secretMatches('a much longer guess than the secret', 'shh_1')).toBe(false);
    expect(secretMatches(undefined, 'shh_1')).toBe(false);
    expect(secretMatches(['shh_1'], 'shh_1')).toBe(false);
  });

  it('refuses to start without a secret', () => {
    expect(() => buildTelegramServer({ db, api, webhookSecret: '' })).toThrow(/B-09/);
  });

  it('has a health endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok', service: 'arbitron-telegram' });
  });
});
