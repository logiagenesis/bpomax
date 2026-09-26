import type { Queryable } from '@arbitron/db';
import type { EmailSender } from '@arbitron/email';
import type { Fetch } from '@arbitron/freelancer';
import type { LlmTransport } from '@arbitron/llm';
import type { ConnectionOptions, Worker } from 'bullmq';
import { createAutoReplyProcessor } from './auto-reply.js';
import { freelancerBidPlacer } from './bid-placer.js';
import { billingSweepProcessor, scheduleBillingSweep } from './billing-sweep.js';
import { createBriefBuildProcessor } from './brief-build.js';
import type { WorkersConfig } from './config.js';
import { createDiscoveryProcessor } from './discovery.js';
import { createDraftProcessor } from './draft-bid.js';
import { within } from './env.js';
import { createEstimateProcessor } from './estimate.js';
import { queueHealth } from './health.js';
import { inboxProcessor, scheduleInboxSync } from './inbox-sync.js';
import { ingestProcessor, scheduleIngestSync } from './ingest.js';
import { createMarginProcessor } from './margin.js';
import { queueNotifier } from './notify.js';
import { closeQueues, createQueues, type QueueName, type QueueSet } from './queues.js';
import { createRepriceProcessor } from './reprice.js';
import { retentionProcessor, scheduleRetention } from './retention.js';
import { startWorker, type Processor } from './runtime.js';
import { createScoreProcessor } from './score.js';
import { createSendMessageProcessor } from './send-message.js';
import { scheduleSourcingCollect, sourcingProcessor } from './sourcing.js';
import { createSubmitProcessor, type BidPlacer } from './submit.js';
import { createUsageAlert } from './usage-alert.js';

/**
 * The workers' composition root (ARB-510, the owner's audit E-02): every queue of
 * docs/01 section E gets its processor, wired to the queues it feeds, and the schedules
 * are created. `main.ts` calls it with the environment's settings; the slice test calls
 * it with PGlite, a scripted model and stand-ins, so what runs in production is what the
 * test runs.
 *
 * Not consumed here: `notify` (the bot process sends Telegram notices, D-075),
 * `price-refresh` (ARB-514), `rollup` (analytics is a view, D-061), and the queues of a
 * feature that is off (`WorkersConfig.off`), which wait for a process that has it.
 */
export interface ComposeOptions {
  /** A service-role connection: the workers act for every org (D-017). */
  readonly db: Queryable;
  readonly connection: ConnectionOptions;
  readonly config: Pick<WorkersConfig, 'liveMode' | 'llm' | 'freelancer' | 'upwork' | 'off'>;
  /** The model transport; null when the model is off. `main.ts` builds Anthropic's. */
  readonly transport: LlmTransport | null;
  /** Prefixes every Redis key, so tests sharing one Redis never collide. */
  readonly prefix?: string;
  /** Marketplace calls; defaults to the global fetch. Tests point it at stand-ins. */
  readonly fetch?: Fetch;
  /**
   * The platform bid call. Defaults to the Freelancer.com placer (ARB-511) when
   * Freelancer.com is configured, and to none (live submission refused) when it is not.
   * It is reached only through the live gate, which is off by default (D-032).
   */
  readonly placer?: BidPlacer | null;
  /** Owners' usage alerts by email; null until B-13, with the reason recorded. */
  readonly email?: EmailSender | null;
  readonly now?: () => Date;
  readonly concurrency?: number;
}

export interface WorkerRuntime {
  readonly queues: QueueSet;
  readonly workers: readonly Worker[];
  /** The queues this process consumes. */
  readonly running: readonly QueueName[];
  /** Features that are off, with why (from the configuration). */
  readonly off: Readonly<Record<string, string>>;
  /** Creates or updates the repeating jobs; safe to run on every start. */
  schedule(): Promise<void>;
  ready(timeoutMs?: number): Promise<RuntimeReadiness>;
  /** Stops taking jobs, waits for the ones running, then closes every connection. */
  close(): Promise<void>;
}

export interface RuntimeReadiness {
  readonly ready: boolean;
  readonly service: 'arbitron-workers';
  readonly database: 'ok' | 'unreachable';
  readonly redis: 'ok' | 'unreachable';
  readonly running: readonly QueueName[];
  readonly off: Readonly<Record<string, string>>;
}

export const MODEL_QUEUES = ['score', 'estimate', 'draft-bid', 'discovery', 'brief-build'] as const;

export function composeWorkers(options: ComposeOptions): WorkerRuntime {
  const { db, config } = options;
  const queues = createQueues({
    connection: options.connection,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });
  const notify = queueNotifier(queues.notify);
  const usageAlert = createUsageAlert({
    db,
    telegram: notify.text,
    email: options.email ?? null,
    emailOffReason: 'no email provider yet (docs/02 B-13)',
  });
  const marketplace = {
    config: config.freelancer,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  };

  const processors: Partial<Record<QueueName, Processor<never, unknown>>> = {
    ingest: ingestProcessor({
      db,
      queue: queues.ingest,
      scoreQueue: queues.score,
      upwork: config.upwork,
      ...marketplace,
    }),
    'inbox-sync': inboxProcessor({
      db,
      queue: queues['inbox-sync'],
      autoReplyQueue: queues['auto-reply'],
      discoveryQueue: queues.discovery,
      alert: notify.inbound,
      ...marketplace,
    }),
    'auto-reply': createAutoReplyProcessor({ db, liveMode: config.liveMode, ...marketplace }),
    'send-message': createSendMessageProcessor({ db, liveMode: config.liveMode, ...marketplace }),
    sourcing: sourcingProcessor({
      db,
      liveMode: config.liveMode,
      repriceQueue: queues.reprice,
      ...marketplace,
    }),
    margin: createMarginProcessor({ db, fx: null, draftQueue: queues['draft-bid'] }),
    reprice: createRepriceProcessor({ db, fx: null, alert: notify.reprice }),
    submit: createSubmitProcessor({
      db,
      liveMode: config.liveMode,
      placer:
        options.placer !== undefined
          ? options.placer
          : config.freelancer
            ? freelancerBidPlacer({
                db,
                config: config.freelancer,
                ...(options.fetch ? { fetch: options.fetch } : {}),
                ...(options.now ? { now: options.now } : {}),
              })
            : null,
      usageAlert,
      ...(options.now ? { now: options.now } : {}),
    }),
    retention: retentionProcessor({ db, ...(options.now ? { now: options.now } : {}) }),
    billing: billingSweepProcessor({ db, ...(options.now ? { now: options.now } : {}) }),
  };

  const transport = options.transport;
  const llm = config.llm;
  if (transport && llm) {
    processors.score = createScoreProcessor({
      db,
      transport,
      model: llm.scoreModel,
      estimateQueue: queues.estimate,
      usageAlert,
    });
    processors.estimate = createEstimateProcessor({
      db,
      transport,
      model: llm.draftModel,
      marginQueue: queues.margin,
    });
    processors['draft-bid'] = createDraftProcessor({
      db,
      transport,
      model: llm.draftModel,
      usageAlert,
      onQueued: notify.queued,
    });
    processors.discovery = createDiscoveryProcessor({
      db,
      transport,
      model: llm.draftModel,
      briefQueue: queues['brief-build'],
      ...(options.now ? { now: options.now } : {}),
    });
    processors['brief-build'] = createBriefBuildProcessor({
      db,
      transport,
      model: llm.draftModel,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  const running = Object.keys(processors) as QueueName[];
  const workers = running.map((name) =>
    startWorker(name, processors[name] as Processor<unknown, unknown>, {
      connection: options.connection,
      deadLetter: queues['dead-letter'],
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    }),
  );

  return {
    queues,
    workers,
    running,
    off: config.off,
    async schedule() {
      await scheduleIngestSync(queues.ingest);
      await scheduleInboxSync(queues['inbox-sync']);
      await scheduleSourcingCollect(queues.sourcing);
      await scheduleRetention(queues.retention);
      await scheduleBillingSweep(queues.billing);
    },
    async ready(timeoutMs = 2_000) {
      const [database, redis] = await Promise.all([
        within(db.query('select 1'), timeoutMs, 'the database').then(
          () => 'ok' as const,
          () => 'unreachable' as const,
        ),
        queueHealth(queues, timeoutMs).then(
          (health) => (health.status === 'ok' ? 'ok' : 'unreachable') as 'ok' | 'unreachable',
        ),
      ]);
      return {
        ready: database === 'ok' && redis === 'ok',
        service: 'arbitron-workers',
        database,
        redis,
        running,
        off: config.off,
      };
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
      await closeQueues(queues);
    },
  };
}
