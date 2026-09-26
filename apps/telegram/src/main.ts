import { createPool } from '@arbitron/db';
import {
  closeQueues,
  createQueues,
  describeProblems,
  logLine,
  onShutdown,
  queueHealth,
  redisConnection,
  startWorker,
  within,
} from '@arbitron/workers';
import { createTelegramApi } from './api.js';
import { botConfig } from './config.js';
import type { BotDeps } from './engine.js';
import { notifyProcessor } from './notify.js';
import { buildTelegramServer } from './server.js';

/**
 * The bot process (ARB-510, the owner's audit E-01): `pnpm --filter @arbitron/telegram
 * start`. It stops at once, naming every missing or malformed variable, without the
 * database, Redis, the bot token or the webhook secret. It serves Telegram's webhook,
 * sends the notices the workers queue (D-075), answers `/health` and `/ready` on PORT,
 * and on SIGTERM finishes what it is doing and closes its connections. The token and the
 * secret are never logged.
 */
const SERVICE = 'arbitron-telegram';

const result = botConfig(process.env);
if (!result.ok) {
  process.stderr.write(`${describeProblems(SERVICE, result.problems)}\n`);
  process.exit(1);
}
const config = result.config;

const db = createPool({
  connectionString: config.databaseUrl,
  applicationName: SERVICE,
  onError: (error) =>
    logLine(SERVICE, 'warn', 'idle database connection lost', { error: error.message }),
});
const connection = redisConnection(config.redisUrl);
const prefix = config.queuePrefix ? { prefix: config.queuePrefix } : {};
const queues = createQueues({ connection, ...prefix });
const deps: BotDeps = {
  db,
  api: createTelegramApi({ token: config.token }),
  submitQueue: queues.submit,
};

const app = buildTelegramServer({
  ...deps,
  webhookSecret: config.webhookSecret,
  logger: true,
  ready: async () => {
    const [database, redis] = await Promise.all([
      within(db.query('select 1'), 2_000, 'the database').then(
        () => 'ok' as const,
        () => 'unreachable' as const,
      ),
      queueHealth(queues).then((health) => (health.status === 'ok' ? 'ok' : 'unreachable')),
    ]);
    return { ready: database === 'ok' && redis === 'ok', database, redis };
  },
});
const notifier = startWorker('notify', notifyProcessor(deps), {
  connection,
  deadLetter: queues['dead-letter'],
  ...prefix,
});
notifier.on('failed', (job, error) =>
  logLine(SERVICE, 'warn', 'notice failed', { jobId: job?.id, error: error.message }),
);

await app.listen({ port: config.port, host: '0.0.0.0' });
if (config.webhookUrl) {
  await deps.api.setWebhook(config.webhookUrl, config.webhookSecret);
  logLine(SERVICE, 'info', 'webhook registered', { url: config.webhookUrl });
}
logLine(SERVICE, 'info', 'started', {
  port: config.port,
  webhook: config.webhookUrl ? 'registered' : 'not registered: TELEGRAM_WEBHOOK_URL is not set',
});

onShutdown(SERVICE, async () => {
  await app.close();
  await notifier.close();
  await closeQueues(queues);
  await db.end();
});
