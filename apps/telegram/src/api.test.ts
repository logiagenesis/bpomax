import { describe, expect, it } from 'vitest';
import { createTelegramApi, parseUpdate } from './api.js';

/** ARB-050: the adapter sends what the Bot API reference says, and the token stays in the URL. */
const TOKEN = '123456:TEST-TOKEN';

function fakeFetch(reply: unknown = { ok: true, result: { message_id: 7 } }, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as unknown });
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(reply) });
  };
  return { calls, fetch };
}

describe('createTelegramApi', () => {
  it('posts sendMessage with chat_id, text and an inline keyboard, to the token s URL', async () => {
    const { calls, fetch } = fakeFetch();
    const api = createTelegramApi({ token: TOKEN, fetch });
    const sent = await api.sendMessage('42', 'Hello', [
      [{ text: 'Approve', callbackData: 'approve:x' }],
    ]);
    expect(sent).toEqual({ messageId: 7 });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({
      chat_id: '42',
      text: 'Hello',
      reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:x' }]] },
    });
  });

  it('refuses callback_data over 64 bytes, and cuts text at 4096 characters', async () => {
    const { calls, fetch } = fakeFetch();
    const api = createTelegramApi({ token: TOKEN, fetch });
    await expect(
      api.sendMessage('42', 'Hi', [[{ text: 'x', callbackData: 'y'.repeat(65) }]]),
    ).rejects.toThrow(/over 64 bytes/);
    await api.sendMessage('42', 'x'.repeat(5000));
    expect((calls[0]?.body as { text: string }).text).toHaveLength(4096);
  });

  it('answers a callback query with at most 200 characters, and clears buttons with an empty keyboard', async () => {
    const { calls, fetch } = fakeFetch({ ok: true, result: true });
    const api = createTelegramApi({ token: TOKEN, fetch });
    await api.answerCallbackQuery('q1', 'a'.repeat(250));
    expect(calls[0]?.url).toMatch(/\/answerCallbackQuery$/);
    expect((calls[0]?.body as { callback_query_id: string; text: string }).text).toHaveLength(200);
    await api.editMessageReplyMarkup('42', 7, null);
    expect(calls[1]?.body).toEqual({
      chat_id: '42',
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('sets the webhook with its secret token, and refuses a secret the API would', async () => {
    const { calls, fetch } = fakeFetch({ ok: true, result: true });
    const api = createTelegramApi({ token: TOKEN, fetch });
    await api.setWebhook('https://bot.example/telegram/webhook', 'secret_1-A');
    expect(calls[0]?.body).toEqual({
      url: 'https://bot.example/telegram/webhook',
      secret_token: 'secret_1-A',
    });
    await expect(api.setWebhook('https://bot.example', 'has spaces')).rejects.toThrow(
      /A-Z, a-z, 0-9/,
    );
  });

  it('reports Telegram s description on failure, and never the token', async () => {
    const { fetch } = fakeFetch(
      { ok: false, description: 'Bad Request: chat not found', error_code: 400 },
      400,
    );
    const api = createTelegramApi({ token: TOKEN, fetch });
    const failure = await api.sendMessage('42', 'Hello').catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Telegram sendMessage failed: Bad Request: chat not found',
    );
    expect((failure as Error).message).not.toContain(TOKEN);
    expect(() => createTelegramApi({ token: '' })).toThrow(/B-09/);
  });
});

describe('parseUpdate', () => {
  it('reads a text message', () => {
    expect(
      parseUpdate({
        update_id: 1,
        message: { message_id: 10, chat: { id: 42 }, from: { id: 99 }, text: '/queue' },
      }),
    ).toEqual({ kind: 'message', chatId: '42', fromId: '99', messageId: 10, text: '/queue' });
  });

  it('reads a button press', () => {
    expect(
      parseUpdate({
        update_id: 2,
        callback_query: {
          id: 'q1',
          from: { id: 99 },
          message: { message_id: 10, chat: { id: 42 } },
          data: 'approve:p',
        },
      }),
    ).toEqual({
      kind: 'callback',
      chatId: '42',
      fromId: '99',
      callbackQueryId: 'q1',
      messageId: 10,
      data: 'approve:p',
    });
  });

  it('ignores what it does not act on', () => {
    expect(
      parseUpdate({ update_id: 3, edited_message: { message_id: 1, chat: { id: 42 }, text: 'x' } }),
    ).toBeNull();
    expect(
      parseUpdate({ update_id: 4, message: { message_id: 1, chat: { id: 42 }, from: { id: 9 } } }),
    ).toBeNull();
    expect(parseUpdate('nope')).toBeNull();
    expect(parseUpdate(null)).toBeNull();
  });
});
