import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { QueueEvents, UnrecoverableError, type Job, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHealthServer, queueHealth } from './health.js';
import {
  DEAD_LETTER_QUEUE,
  QUEUE_NAMES,
  closeQueues,
  createQueues,
  defaultJobOptions,
  redisConnection,
  type QueueSet,
} from './queues.js';
import { startWorker, type DeadLetter } from './runtime.js';

/**
 * ARB-030 against a real Redis. CI runs one as a service container; locally, run
 * `redis-server` or `docker compose up -d redis`. There is no fake: BullMQ is Lua
 * scripts inside Redis, and a mock would prove only that the mock works.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const connection = redisConnection(REDIS_URL);

let prefix: string;
let queues: QueueSet;
const workers: Pick<Worker, 'close'>[] = [];
const listeners: QueueEvents[] = [];

beforeAll(() => {
  prefix = `arb-test-${randomUUID()}`;
  queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 20 });
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

afterAll(async () => {
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
});

async function eventsFor(name: string): Promise<QueueEvents> {
  const listener = new QueueEvents(name, { connection, prefix });
  listeners.push(listener);
  await listener.waitUntilReady();
  return listener;
}

async function deadLetterFor(queue: string, jobId: string): Promise<Job<DeadLetter> | undefined> {
  return (await queues[DEAD_LETTER_QUEUE].getJob(`${queue}__${jobId}`)) as Job<DeadLetter>;
}

describe('redisConnection', () => {
  it('reads host, port, credentials and database from the URL', () => {
    expect(redisConnection('rediss://user:p%40ss@cache.example:6380/2')).toEqual({
      host: 'cache.example',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('refuses a URL that is not Redis', () => {
    expect(() => redisConnection('http://localhost:6379')).toThrow(/redis:\/\//);
  });
});

describe('defaultJobOptions', () => {
  it('retries with exponential backoff by default', () => {
    expect(defaultJobOptions()).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  });
});

describe('queues', () => {
  it('has one queue per worker in docs/01 section E, and a dead-letter queue', () => {
    expect(Object.keys(queues).sort()).toEqual([...QUEUE_NAMES, DEAD_LETTER_QUEUE].sort());
  });
});

describe('a job that keeps failing', () => {
  it('is retried with backoff, then lands in the dead-letter queue', async () => {
    const attemptTimes: number[] = [];
    const events = await eventsFor('score');
    workers.push(
      startWorker(
        'score',
        async () => {
          attemptTimes.push(Date.now());
          throw new Error('model returned nonsense');
        },
        { connection, prefix, deadLetter: queues[DEAD_LETTER_QUEUE] },
      ),
    );

    const job = await queues.score.add('score-job', { jobId: 'j-1' });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('model returned nonsense');

    expect(attemptTimes).toHaveLength(3);
    // Exponential: 20 ms, then 40 ms. Each gap is at least its delay, and the second
    // is longer than the first would allow on its own.
    const [first, second, third] = attemptTimes as [number, number, number];
    expect(second - first).toBeGreaterThanOrEqual(20);
    expect(third - second).toBeGreaterThanOrEqual(40);

    expect(await job.getState()).toBe('failed');
    const letter = await deadLetterFor('score', String(job.id));
    expect(letter?.data).toMatchObject({
      queue: 'score',
      jobId: String(job.id),
      jobName: 'score-job',
      data: { jobId: 'j-1' },
      attemptsMade: 3,
      failedReason: 'model returned nonsense',
    });
  });

  it('is not dead-lettered while it still has attempts left', async () => {
    let calls = 0;
    const events = await eventsFor('estimate');
    workers.push(
      startWorker(
        'estimate',
        async () => {
          calls += 1;
          if (calls < 3) throw new Error('transient');
          return 'done';
        },
        { connection, prefix, deadLetter: queues[DEAD_LETTER_QUEUE] },
      ),
    );

    const job = await queues.estimate.add('estimate-job', {});
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toBe('done');
    expect(calls).toBe(3);
    expect(await deadLetterFor('estimate', String(job.id))).toBeUndefined();
  });

  it('goes straight to the dead-letter queue when the error is unrecoverable', async () => {
    let calls = 0;
    const events = await eventsFor('margin');
    workers.push(
      startWorker(
        'margin',
        async () => {
          calls += 1;
          throw new UnrecoverableError('no fee table for this platform');
        },
        { connection, prefix, deadLetter: queues[DEAD_LETTER_QUEUE] },
      ),
    );

    const job = await queues.margin.add('margin-job', {});
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('no fee table');
    expect(calls).toBe(1);
    expect((await deadLetterFor('margin', String(job.id)))?.data.attemptsMade).toBe(1);
  });
});

describe('health', () => {
  it('reports every queue and the dead-letter count', async () => {
    const health = await queueHealth(queues);
    expect(health.status).toBe('ok');
    expect(health.redis).toBe('ok');
    expect(Object.keys(health.queues).sort()).toEqual([...QUEUE_NAMES, DEAD_LETTER_QUEUE].sort());
    // Two dead letters were filed above: one from score, one from margin.
    expect(health.deadLetters).toBe(2);
    expect(health.queues.score?.failed).toBe(1);
  });

  it('answers GET /health over HTTP with 200 and the counts', async () => {
    const server = createHealthServer(queues).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deadLetters: number; queues: object };
      expect(body.deadLetters).toBe(2);
      expect(Object.keys(body.queues)).toContain('ingest');
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports down, and 503, when Redis cannot be reached', async () => {
    const unreachable = createQueues({
      connection: { ...redisConnection('redis://127.0.0.1:1'), enableOfflineQueue: false },
      prefix,
    });
    const server = createHealthServer(unreachable, 300).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'down', redis: 'unreachable' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await closeQueues(unreachable).catch(() => undefined);
    }
  });
});
