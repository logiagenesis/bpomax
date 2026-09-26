import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, QUEUE_NAMES, redisConnection } from './queues.js';

/**
 * ARB-510, the owner's audit E-01: "`pnpm --filter <pkg> start` runs each process;
 * missing env fails start". All three live here beside the runtime helpers they share
 * (env.ts). Each process is started as a host would start it, with
 * `tsx src/main.ts` (the `start` script), against a real Postgres and Redis, then asked
 * for `/health` and `/ready` and stopped with SIGTERM.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = `${ROOT}node_modules/.bin/tsx`;
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const PREFIX = `services-${randomUUID().slice(0, 8)}`;

/** Values that must never reach a log line. */
const SECRETS = {
  SUPABASE_ANON_KEY: 'anon-key-never-logged',
  MCP_CHANNEL_KEY: 'channel-key-never-logged',
  TELEGRAM_BOT_TOKEN: '123456:TOKEN-never-logged',
  TELEGRAM_WEBHOOK_SECRET: 'webhook_secret_never_logged',
};

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  stdout: string;
  stderr: string;
  readonly exited: Promise<number | null>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function start(app: string, env: Record<string, string>, port = 0): Running {
  const child = spawn(TSX, ['src/main.ts'], {
    cwd: `${ROOT}apps/${app}`,
    // Only what is given: nothing from the test's own environment leaks in.
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const running: Running = {
    child,
    port,
    stdout: '',
    stderr: '',
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  };
  child.stdout?.on('data', (chunk: Buffer) => (running.stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (running.stderr += chunk.toString()));
  return running;
}

async function started(running: Running): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!/"message":"started"/.test(running.stdout)) {
    if (running.child.exitCode !== null)
      throw new Error(`exited early:\n${running.stdout}\n${running.stderr}`);
    if (Date.now() > deadline)
      throw new Error(`did not start:\n${running.stdout}\n${running.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stop(running: Running): Promise<number | null> {
  running.child.kill('SIGTERM');
  return running.exited;
}

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${String(port)}${path}`, { headers });

const COMMON = { DATABASE_URL, REDIS_URL, QUEUE_PREFIX: PREFIX, LIVE_MODE: 'false' };

afterAll(async () => {
  const connection = redisConnection(REDIS_URL);
  for (const name of [...QUEUE_NAMES, DEAD_LETTER_QUEUE]) {
    const queue = new Queue(name, { connection, prefix: PREFIX });
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

describe.each([
  ['api', ['DATABASE_URL', 'REDIS_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APP_URL']],
  ['workers', ['DATABASE_URL', 'REDIS_URL']],
  ['telegram', ['DATABASE_URL', 'REDIS_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']],
] as const)('%s without its settings', (app, names) => {
  it('does not start, and names every missing setting', async () => {
    const running = start(app, {});
    expect(await running.exited).toBe(1);
    for (const name of names) expect(running.stderr).toContain(`- ${name} is not set`);
    expect(running.stdout).toBe('');
  }, 60_000);
});

describe('the API process', () => {
  it('starts, answers health and ready, refuses a forged channel, and stops on SIGTERM', async () => {
    const port = await freePort();
    const running = start(
      'api',
      {
        ...COMMON,
        PORT: String(port),
        SUPABASE_URL: 'http://127.0.0.1:9',
        SUPABASE_ANON_KEY: SECRETS.SUPABASE_ANON_KEY,
        APP_URL: 'https://bpomax.vercel.app',
        MCP_CHANNEL_KEY: SECRETS.MCP_CHANNEL_KEY,
      },
      port,
    );
    await started(running);
    expect((await get(port, '/health')).status).toBe(200);
    const ready = await get(port, '/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      service: 'arbitron-api',
      ready: true,
      database: 'ok',
      redis: 'ok',
    });
    expect((await get(port, '/v1/me')).status).toBe(401);
    expect((await get(port, '/v1/me', { 'x-arbitron-channel': 'mcp' })).status).toBe(403);

    expect(await stop(running)).toBe(0);
    expect(running.stdout).toMatch(/"message":"stopped"/);
    for (const secret of Object.values(SECRETS)) {
      expect(running.stdout).not.toContain(secret);
      expect(running.stderr).not.toContain(secret);
    }
  }, 90_000);
});

describe('the workers process', () => {
  it('starts with the model off and says so, answers health and ready, and stops on SIGTERM', async () => {
    const port = await freePort();
    const running = start('workers', { ...COMMON, PORT: String(port) }, port);
    await started(running);
    const startLine = JSON.parse(
      running.stdout.split('\n').find((line) => line.includes('"message":"started"'))!,
    ) as { running: string[]; off: Record<string, string>; liveMode: boolean };
    expect(startLine.liveMode).toBe(false);
    expect(startLine.running).toContain('submit');
    expect(startLine.running).not.toContain('score');
    expect(startLine.off.model).toMatch(/ANTHROPIC_API_KEY is not set/);

    expect((await get(port, '/health')).status).toBe(200);
    const ready = await get(port, '/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, database: 'ok', redis: 'ok' });

    expect(await stop(running)).toBe(0);
    expect(running.stdout).toMatch(/"message":"stopped"/);
  }, 90_000);
});

describe('the bot process', () => {
  it('starts without registering a webhook, refuses an update without the secret, and stops on SIGTERM', async () => {
    const port = await freePort();
    const running = start(
      'telegram',
      {
        ...COMMON,
        PORT: String(port),
        TELEGRAM_BOT_TOKEN: SECRETS.TELEGRAM_BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET: SECRETS.TELEGRAM_WEBHOOK_SECRET,
      },
      port,
    );
    await started(running);
    expect(running.stdout).toMatch(/not registered: TELEGRAM_WEBHOOK_URL is not set/);
    expect((await get(port, '/health')).status).toBe(200);
    expect((await get(port, '/ready')).status).toBe(200);
    const update = await fetch(`http://127.0.0.1:${String(port)}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(update.status).toBe(401);

    expect(await stop(running)).toBe(0);
    for (const secret of Object.values(SECRETS)) {
      expect(running.stdout).not.toContain(secret);
      expect(running.stderr).not.toContain(secret);
    }
  }, 90_000);
});
