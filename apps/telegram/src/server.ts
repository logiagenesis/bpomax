import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseUpdate } from './api.js';
import { handleUpdate, type BotDeps } from './engine.js';

/**
 * The webhook receiver (ARB-050, docs/01 section C: "Telegram Bot API (webhook)").
 *
 * Telegram sends the secret given to setWebhook back on every update in the
 * X-Telegram-Bot-Api-Secret-Token header (https://core.telegram.org/bots/api#setwebhook);
 * an update without it is not Telegram's and is refused. Once accepted, an update is
 * answered 200 whatever the bot makes of it: an error is logged here, and a non-200 would
 * only make Telegram send the same update again.
 */
export interface TelegramServerOptions extends BotDeps {
  readonly webhookSecret: string;
  readonly logger?: boolean;
}

export const WEBHOOK_PATH = '/telegram/webhook';

/**
 * Compares the header with the secret in constant time, so the time taken says nothing
 * about how much of a guess was right (ARB-500, the owner's audit S-08). Both sides are
 * hashed first, which makes them the same length whatever was sent.
 */
export function secretMatches(sent: unknown, secret: string): boolean {
  if (typeof sent !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(sent), digest(secret));
}
export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export function buildTelegramServer(options: TelegramServerOptions): FastifyInstance {
  if (!options.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set (docs/02 B-09)');
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({ status: 'ok', service: 'arbitron-telegram' }));

  app.post(WEBHOOK_PATH, async (request, reply) => {
    if (!secretMatches(request.headers[SECRET_HEADER], options.webhookSecret)) {
      return reply.code(401).send({ error: 'not from Telegram' });
    }
    const incoming = parseUpdate(request.body);
    if (incoming) {
      try {
        await handleUpdate(options, incoming);
      } catch (error) {
        request.log.error({ err: error }, 'telegram update failed');
        return reply.send({ ok: false });
      }
    }
    return reply.send({ ok: true });
  });

  return app;
}
