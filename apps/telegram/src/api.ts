/**
 * The Telegram Bot API, reduced to the five calls the bot makes (ARB-050).
 *
 * Method and field names are the Bot API's, read from https://core.telegram.org/bots/api on
 * 22/09/2026 (the page's latest changes were dated 24/08/2026):
 *   making requests   https://core.telegram.org/bots/api#making-requests
 *   sendMessage       https://core.telegram.org/bots/api#sendmessage
 *   InlineKeyboard    https://core.telegram.org/bots/api#inlinekeyboardmarkup (callback_data: 1–64 bytes)
 *   answerCallbackQuery https://core.telegram.org/bots/api#answercallbackquery
 *   editMessageReplyMarkup https://core.telegram.org/bots/api#editmessagereplymarkup
 *   setWebhook        https://core.telegram.org/bots/api#setwebhook (secret_token, sent back as
 *                     the X-Telegram-Bot-Api-Secret-Token header on every update)
 *   getMe             https://core.telegram.org/bots/api#getme
 *
 * The token goes into the URL and nowhere else: never into a log line, an event or an
 * error message (05 section 4.3).
 */
export interface TelegramButton {
  readonly text: string;
  /** What comes back in `callback_query.data` when pressed. At most 64 bytes. */
  readonly callbackData: string;
}

export interface TelegramApi {
  sendMessage(
    chatId: string,
    text: string,
    buttons?: readonly (readonly TelegramButton[])[],
  ): Promise<{ messageId: number }>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** `null` removes the buttons, which is how a card is closed once it has been acted on. */
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    buttons: readonly (readonly TelegramButton[])[] | null,
  ): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  getMe(): Promise<{ id: number; username: string }>;
}

export const CALLBACK_DATA_MAX_BYTES = 64;
/** sendMessage: "1-4096 characters after entities parsing". */
export const MESSAGE_TEXT_MAX = 4096;
/** answerCallbackQuery text: "0-200 characters". */
export const CALLBACK_ANSWER_MAX = 200;
/** setWebhook secret_token: "1-256 characters. Only characters A-Z, a-z, 0-9, _ and - are allowed." */
export const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

type Fetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface TelegramApiOptions {
  readonly token: string;
  /** Injected so tests never reach the network. Defaults to the global fetch. */
  readonly fetch?: Fetch;
  readonly baseUrl?: string;
}

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function keyboard(buttons: readonly (readonly TelegramButton[])[] | null) {
  if (buttons === null) return { inline_keyboard: [] };
  for (const row of buttons) {
    for (const button of row) {
      if (Buffer.byteLength(button.callbackData, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
        throw new Error(
          `callback_data "${button.callbackData}" is over ${String(CALLBACK_DATA_MAX_BYTES)} bytes`,
        );
      }
    }
  }
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
    ),
  };
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  if (!options.token) throw new Error('TELEGRAM_BOT_TOKEN is not set (docs/02 B-09)');
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base = `${options.baseUrl ?? 'https://api.telegram.org'}/bot${options.token}`;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await doFetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = (await response.json()) as BotApiResponse<T>;
    if (!response.ok || !body.ok || body.result === undefined) {
      // The description is Telegram's own wording and carries no token.
      throw new Error(
        `Telegram ${method} failed: ${body.description ?? `HTTP ${String(response.status)}`}`,
      );
    }
    return body.result;
  }

  return {
    async sendMessage(chatId, text, buttons) {
      if (text.length > MESSAGE_TEXT_MAX) text = `${text.slice(0, MESSAGE_TEXT_MAX - 1)}…`;
      const sent = await call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
      });
      return { messageId: sent.message_id };
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call<boolean>('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text: text.slice(0, CALLBACK_ANSWER_MAX) } : {}),
      });
    },
    async editMessageReplyMarkup(chatId, messageId, buttons) {
      await call<unknown>('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard(buttons),
      });
    },
    async setWebhook(url, secretToken) {
      if (!WEBHOOK_SECRET_PATTERN.test(secretToken)) {
        throw new Error(
          'TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ or -',
        );
      }
      await call<boolean>('setWebhook', { url, secret_token: secretToken });
    },
    async getMe() {
      const me = await call<{ id: number; username: string }>('getMe', {});
      return { id: me.id, username: me.username };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Incoming updates, https://core.telegram.org/bots/api#update

export interface IncomingMessage {
  readonly kind: 'message';
  readonly chatId: string;
  readonly fromId: string;
  readonly messageId: number;
  readonly text: string;
}

export interface IncomingCallback {
  readonly kind: 'callback';
  readonly chatId: string;
  readonly fromId: string;
  readonly callbackQueryId: string;
  readonly messageId: number | null;
  readonly data: string;
}

export type Incoming = IncomingMessage | IncomingCallback;

interface RawUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    from?: { id: number | string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number | string };
    message?: { message_id: number; chat: { id: number | string } };
    data?: string;
  };
}

/** The parts of an Update the bot acts on. Anything else (edits, joins, media) is ignored. */
export function parseUpdate(body: unknown): Incoming | null {
  if (typeof body !== 'object' || body === null) return null;
  const update = body as RawUpdate;
  if (update.callback_query) {
    const q = update.callback_query;
    if (!q.message) return null;
    return {
      kind: 'callback',
      chatId: String(q.message.chat.id),
      fromId: String(q.from.id),
      callbackQueryId: String(q.id),
      messageId: q.message.message_id,
      data: q.data ?? '',
    };
  }
  if (update.message?.from && typeof update.message.text === 'string') {
    return {
      kind: 'message',
      chatId: String(update.message.chat.id),
      fromId: String(update.message.from.id),
      messageId: update.message.message_id,
      text: update.message.text,
    };
  }
  return null;
}
