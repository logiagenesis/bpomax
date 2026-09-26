import { createPool } from '@arbitron/db';
import {
  apiEnqueue,
  closeQueues,
  createQueues,
  describeProblems,
  logLine,
  onShutdown,
  queueHealth,
  redisConnection,
  within,
} from '@arbitron/workers';
import { supabaseAuthenticator } from './auth.js';
import { apiConfig } from './config.js';
import { buildServer } from './server.js';

/**
 * The API process (ARB-510, the owner's audit E-01 and E-02): `pnpm --filter
 * @arbitron/api start`. It stops at once, naming every missing or malformed variable,
 * without the database, Redis, Supabase or the web app's address. It hands approvals to
 * real queues, answers `/health` and `/ready` on PORT, and on SIGTERM stops taking
 * requests, finishes the ones in flight and closes its connections.
 */
const SERVICE = 'arbitron-api';

const result = apiConfig(process.env);
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
const queues = createQueues({
  connection: redisConnection(config.redisUrl),
  ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
});

const app = buildServer({
  db,
  authenticate: supabaseAuthenticator({
    url: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
  }),
  logger: true,
  webOrigin: config.webOrigin,
  enqueue: apiEnqueue(queues),
  liveMode: config.liveMode,
  freelancer: { config: config.freelancer },
  upwork: { config: config.upwork },
  billing: { config: config.billing },
  // The FX provider waits on docs/02 B-10; a payment not in rand takes a typed rate.
  fx: null,
  ...(config.mcpChannelKey ? { mcpChannelKey: config.mcpChannelKey } : {}),
  ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
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

await app.listen({ port: config.port, host: '0.0.0.0' });
logLine(SERVICE, 'info', 'started', {
  port: config.port,
  liveMode: config.liveMode,
  freelancer: config.freelancer.ok ? 'on' : config.freelancer.reason,
  upwork: config.upwork.ok ? 'on' : config.upwork.reason,
  mcpChannel: config.mcpChannelKey ? 'on' : 'off: MCP_CHANNEL_KEY is not set',
});

onShutdown(SERVICE, async () => {
  await app.close();
  await closeQueues(queues);
  await db.end();
});
