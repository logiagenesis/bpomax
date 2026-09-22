import { createServer, type Server } from 'node:http';
import { DEAD_LETTER_QUEUE, type QueueSet } from './queues.js';

const COUNTED_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

export type QueueCounts = Record<(typeof COUNTED_STATES)[number], number>;

export interface WorkerHealth {
  /** `ok` when Redis answers; `down` when it does not. Dead letters do not make it `down`. */
  readonly status: 'ok' | 'down';
  readonly service: 'arbitron-workers';
  readonly redis: 'ok' | 'unreachable';
  readonly queues: Record<string, QueueCounts>;
  /** Pulled out of `queues` because it is the number an operator should alert on. */
  readonly deadLetters: number;
  readonly error?: string;
}

/**
 * A health check that waits on a lost Redis never answers: ioredis keeps reconnecting and
 * the queue's client promise stays pending. Past this, Redis counts as unreachable.
 */
export const HEALTH_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function queueHealth(
  queues: QueueSet,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<WorkerHealth> {
  try {
    return await withTimeout(countQueues(queues), timeoutMs);
  } catch (error) {
    return {
      status: 'down',
      service: 'arbitron-workers',
      redis: 'unreachable',
      queues: {},
      deadLetters: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function countQueues(queues: QueueSet): Promise<WorkerHealth> {
  const entries = await Promise.all(
    Object.entries(queues).map(async ([name, queue]) => {
      const counts = await queue.getJobCounts(...COUNTED_STATES);
      const tidy = Object.fromEntries(
        COUNTED_STATES.map((state) => [state, counts[state] ?? 0]),
      ) as QueueCounts;
      return [name, tidy] as const;
    }),
  );
  const byName = Object.fromEntries(entries);
  const dead = byName[DEAD_LETTER_QUEUE];
  return {
    status: 'ok',
    service: 'arbitron-workers',
    redis: 'ok',
    queues: byName,
    // Every dead letter is filed once and never completed, so "all of them" is the count.
    deadLetters: dead ? dead.waiting + dead.active + dead.delayed + dead.failed : 0,
  };
}

/**
 * `GET /health` for the worker process. 200 while Redis answers, 503 when it does not,
 * so a host's health check restarts a worker that has lost its queue rather than one
 * that merely has dead letters waiting to be read.
 */
export function createHealthServer(queues: QueueSet, timeoutMs?: number): Server {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    queueHealth(queues, timeoutMs).then((health) => {
      response.writeHead(health.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(health));
    });
  });
}
