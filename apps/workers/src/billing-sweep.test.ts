import { randomUUID } from 'node:crypto';
import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BILLING_PATTERN,
  BILLING_SCHEDULER_ID,
  billingSweepProcessor,
  scheduleBillingSweep,
} from './billing-sweep.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-420: "failed payment downgrades after grace period", as the daily run records it.
 * Real Redis for the schedule and the worker, real Postgres (PGlite) for the rows. The
 * grace end dates are test values.
 */
const NOW = new Date('2026-10-01T08:00:00Z');
const ENDED = fixtureId('a', ENTITY.org);
const RUNNING = fixtureId('b', ENTITY.org);

const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const prefix = `arb-test-${randomUUID()}`;
const queues = createQueues({ connection, prefix, attempts: 1, backoffMs: 10 });
let db: PGlite;
let worker: Worker;
let events: QueueEvents;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ENDED, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(RUNNING, 'b', 'b')) await db.exec(row.sql);
  await db.query(
    `update subscriptions set status = 'past_due', grace_until = $2 where org_id = $1`,
    [ENDED, '2026-10-01T08:00:00Z'],
  );
  await db.query(
    `update subscriptions set status = 'past_due', grace_until = $2 where org_id = $1`,
    [RUNNING, '2026-10-01T08:00:01Z'],
  );
  worker = startWorker('billing', billingSweepProcessor({ db, now: () => NOW }), {
    connection,
    prefix,
    deadLetter: queues[DEAD_LETTER_QUEUE],
  });
  events = new QueueEvents('billing', { connection, prefix });
  await events.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await db.close();
});

describe('the billing sweep', () => {
  it('is one daily scheduler at 00:30 UTC (02:30 SAST), however many processes start', async () => {
    await scheduleBillingSweep(queues.billing);
    await scheduleBillingSweep(queues.billing);
    const schedulers = await queues.billing.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: BILLING_SCHEDULER_ID,
      name: 'sweep',
      pattern: BILLING_PATTERN,
    });
    await queues.billing.removeJobScheduler(BILLING_SCHEDULER_ID);
  });

  it('cancels a plan whose grace period has ended, and only that one, and records it', async () => {
    const job = await queues.billing.add('sweep', {});
    const run = (await job.waitUntilFinished(events, 30_000)) as {
      downgraded: { orgId: string; plan: string }[];
    };
    expect(run.downgraded).toEqual([{ orgId: ENDED, plan: 'starter' }]);
    const { rows } = await db.query<{ org_id: string; status: string }>(
      'select org_id, status from subscriptions order by org_id',
    );
    expect(rows).toEqual([
      { org_id: ENDED, status: 'cancelled' },
      { org_id: RUNNING, status: 'past_due' },
    ]);
    const logged = await listEvents(db, { type: 'billing.downgraded' });
    expect(logged.map((e) => e.org_id)).toEqual([ENDED]);
  });

  it('a second run the same day finds nothing more to do', async () => {
    const job = await queues.billing.add('sweep', {});
    const run = (await job.waitUntilFinished(events, 30_000)) as { downgraded: unknown[] };
    expect(run.downgraded).toEqual([]);
  });
});
