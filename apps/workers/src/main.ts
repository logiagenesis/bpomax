import { createPool } from '@arbitron/db';
import { AnthropicTransport } from '@arbitron/llm';
import { composeWorkers } from './compose.js';
import { workersConfig } from './config.js';
import { describeProblems, logLine, onShutdown } from './env.js';
import { createHealthServer } from './health.js';
import { redisConnection } from './queues.js';

/**
 * The workers process (ARB-510, the owner's audit E-01 and E-02): `pnpm --filter
 * @arbitron/workers start`. It reads the environment and stops at once, naming every
 * missing or malformed variable, if the database or Redis is not set; then it runs every
 * queue's processor, creates the schedules, and answers `/health` and `/ready` on PORT.
 * SIGTERM stops it taking jobs, waits for the running ones and closes its connections.
 */
const SERVICE = 'arbitron-workers';

const result = workersConfig(process.env);
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
const transport = config.llm ? new AnthropicTransport(config.llm.apiKey, config.llm.baseUrl) : null;

const runtime = composeWorkers({
  db,
  connection,
  config,
  transport,
  ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
});
for (const worker of runtime.workers) {
  worker.on('failed', (job, error) =>
    logLine(SERVICE, 'warn', 'job failed', {
      queue: worker.name,
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: error.message,
    }),
  );
  worker.on('error', (error) =>
    logLine(SERVICE, 'error', 'worker error', { queue: worker.name, error: error.message }),
  );
}
await runtime.schedule();

const server = createHealthServer(runtime.queues, undefined, () => runtime.ready());
await new Promise<void>((resolve) => server.listen(config.port, resolve));

logLine(SERVICE, 'info', 'started', {
  port: config.port,
  liveMode: config.liveMode,
  running: runtime.running,
  off: runtime.off,
});

onShutdown(SERVICE, async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await runtime.close();
  await db.end();
});
