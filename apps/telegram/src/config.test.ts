import { describe, expect, it } from 'vitest';
import { botConfig } from './config.js';

/** ARB-510 (the owner's audit E-01): the bot starts only with what it needs. */
const BASE = {
  DATABASE_URL: 'postgresql://arbitron:pw@db.example.test:5432/postgres',
  REDIS_URL: 'redis://redis.example.test:6379',
  TELEGRAM_BOT_TOKEN: '123456:ABC-token',
  TELEGRAM_WEBHOOK_SECRET: 'shh_1',
};

describe('botConfig', () => {
  it('refuses to start without the database, Redis, the token and the secret', () => {
    const result = botConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.split(' ')[0])).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
    ]);
  });

  it('starts without a webhook address, and registers none', () => {
    const result = botConfig(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ webhookUrl: null, port: 3002, queuePrefix: null });
  });

  it('takes an https webhook address that ends in the path the bot serves', () => {
    const good = botConfig({
      ...BASE,
      TELEGRAM_WEBHOOK_URL: 'https://bot.example.test/telegram/webhook',
    });
    expect(good.ok && good.config.webhookUrl).toBe('https://bot.example.test/telegram/webhook');
    for (const [url, problem] of [
      ['http://bot.example.test/telegram/webhook', 'TELEGRAM_WEBHOOK_URL must be https'],
      ['https://bot.example.test/hook', 'TELEGRAM_WEBHOOK_URL must end in /telegram/webhook'],
      ['not a url', 'TELEGRAM_WEBHOOK_URL is not a URL'],
    ] as const) {
      const result = botConfig({ ...BASE, TELEGRAM_WEBHOOK_URL: url });
      expect(result.ok ? null : result.problems).toEqual([problem]);
    }
  });

  it('refuses a webhook secret Telegram would not accept, without repeating it', () => {
    const result = botConfig({ ...BASE, TELEGRAM_WEBHOOK_SECRET: 'has spaces and !' });
    expect(result.ok ? null : result.problems).toEqual([
      'TELEGRAM_WEBHOOK_SECRET must be 1 to 256 characters of A-Z, a-z, 0-9, _ or -',
    ]);
  });
});
