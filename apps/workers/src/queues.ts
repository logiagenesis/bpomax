import { Queue, type ConnectionOptions, type DefaultJobOptions } from 'bullmq';

/**
 * Queue wiring (ARB-030, docs/01 sections C and E).
 *
 * One queue per worker in section E, plus a dead-letter queue. The names are fixed here
 * so that the health endpoint, the workers and anything that enqueues agree on them.
 */
export const QUEUE_NAMES = [
  'ingest',
  'score',
  'estimate',
  'margin',
  'draft-bid',
  'submit',
  'inbox-sync',
  'auto-reply',
  'discovery',
  'brief-build',
  'sourcing',
  'reprice',
  'price-refresh',
  'rollup',
  // Not in section E: the scheduled retention run ARB-015 asks for (D-039), the
  // approved-message sender ARB-122 asks for (D-048), and ARB-420's daily billing sweep
  // (D-070).
  'retention',
  'send-message',
  'billing',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * BullMQ has no dead-letter queue of its own: a job that runs out of attempts sits in
 * its queue's failed set, mixed in with nothing to tell it apart and trimmed by age. A
 * separate queue gives an operator one place to look and one count to alert on.
 */
export const DEAD_LETTER_QUEUE = 'dead-letter';

/**
 * docs/01 section E: "retried with exponential backoff". Five attempts at 5 s doubling
 * is 5 s, 10 s, 20 s, 40 s — a little over a minute — which rides out a marketplace
 * rate-limit window or a brief network drop without holding a job for hours.
 */
export const DEFAULT_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 5_000;

export function defaultJobOptions(
  overrides: { attempts?: number; backoffMs?: number } = {},
): DefaultJobOptions {
  return {
    attempts: overrides.attempts ?? DEFAULT_ATTEMPTS,
    backoff: { type: 'exponential', delay: overrides.backoffMs ?? DEFAULT_BACKOFF_MS },
    // Completed jobs are evidence of nothing the events table does not already hold.
    removeOnComplete: { count: 1_000 },
    // Failed jobs are kept longer: they are what someone will want to read tomorrow.
    removeOnFail: { count: 5_000 },
  };
}

/** Parses REDIS_URL into the options BullMQ passes to ioredis. */
export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must be a redis:// or rediss:// URL, got ${parsed.protocol}`);
  }
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    // BullMQ requires this for workers: a blocking command must wait, not give up.
    maxRetriesPerRequest: null,
  };
}

export interface QueueSetOptions {
  readonly connection: ConnectionOptions;
  /** Prefixes every key, so tests and environments sharing one Redis never collide. */
  readonly prefix?: string;
  readonly attempts?: number;
  readonly backoffMs?: number;
}

export type QueueSet = Record<QueueName | typeof DEAD_LETTER_QUEUE, Queue>;

export function createQueues(options: QueueSetOptions): QueueSet {
  const jobOptions = defaultJobOptions(options);
  const make = (name: string, defaults: DefaultJobOptions) =>
    new Queue(name, {
      connection: options.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
      defaultJobOptions: defaults,
    });

  const queues = {} as QueueSet;
  for (const name of QUEUE_NAMES) queues[name] = make(name, jobOptions);
  // A dead letter is never retried by the queue itself; putting it back is a decision.
  queues[DEAD_LETTER_QUEUE] = make(DEAD_LETTER_QUEUE, { attempts: 1, removeOnComplete: false });
  return queues;
}

export async function closeQueues(queues: QueueSet): Promise<void> {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
}
