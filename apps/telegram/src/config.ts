import { EnvProblems, type Env } from '@arbitron/workers';
import { WEBHOOK_SECRET_PATTERN } from './api.js';
import { WEBHOOK_PATH } from './server.js';

/**
 * The bot process's settings (ARB-510, the owner's audit E-01). Required: the database,
 * Redis (the submit queue it hands approvals to, and the notices it sends), the bot
 * token and the webhook secret (docs/02 B-09). TELEGRAM_WEBHOOK_URL is optional: when
 * set, the bot registers it with Telegram on start; it must be https, as Telegram's
 * setWebhook requires (https://core.telegram.org/bots/api#setwebhook), and end in the
 * path the bot serves.
 */
export interface BotConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly token: string;
  readonly webhookSecret: string;
  readonly webhookUrl: string | null;
  readonly port: number;
  /** QUEUE_PREFIX, when one Redis serves more than one environment. */
  readonly queuePrefix: string | null;
}

export type BotConfigResult =
  | { readonly ok: true; readonly config: BotConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export const BOT_DEFAULT_PORT = 3002;

export function botConfig(env: Env): BotConfigResult {
  const check = new EnvProblems();
  const databaseUrl = check.requiredUrl(
    env,
    'DATABASE_URL',
    'the Postgres the bot reads and writes (docs/02 B-06)',
    ['postgres', 'postgresql'],
  );
  const redisUrl = check.requiredUrl(
    env,
    'REDIS_URL',
    'the submit queue and the notices to send (docs/02 B-07)',
    ['redis', 'rediss'],
  );
  const token = check.required(env, 'TELEGRAM_BOT_TOKEN', 'from BotFather (docs/02 B-09)');
  const webhookSecret = check.required(
    env,
    'TELEGRAM_WEBHOOK_SECRET',
    'the header Telegram sends with every update (docs/02 B-09)',
  );
  if (webhookSecret && !WEBHOOK_SECRET_PATTERN.test(webhookSecret))
    check.problems.push(
      'TELEGRAM_WEBHOOK_SECRET must be 1 to 256 characters of A-Z, a-z, 0-9, _ or -',
    );
  const port = check.port(env, BOT_DEFAULT_PORT);
  const queuePrefix = check.queuePrefix(env);

  const rawUrl = env.TELEGRAM_WEBHOOK_URL?.trim() ?? '';
  let webhookUrl: string | null = null;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') check.problems.push('TELEGRAM_WEBHOOK_URL must be https');
      else if (!url.pathname.endsWith(WEBHOOK_PATH))
        check.problems.push(`TELEGRAM_WEBHOOK_URL must end in ${WEBHOOK_PATH}`);
      else webhookUrl = url.href;
    } catch {
      check.problems.push('TELEGRAM_WEBHOOK_URL is not a URL');
    }
  }
  if (check.problems.length > 0) return { ok: false, problems: check.problems };
  return {
    ok: true,
    config: { databaseUrl, redisUrl, token, webhookSecret, webhookUrl, port, queuePrefix },
  };
}
