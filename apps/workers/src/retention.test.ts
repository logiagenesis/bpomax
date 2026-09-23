import { randomUUID } from 'node:crypto';
import { REDACTED_TEXT, listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import {
  RETENTION_PATTERN,
  RETENTION_SCHEDULER_ID,
  retentionProcessor,
  scheduleRetention,
  type RetentionRun,
} from './retention.js';
import { startWorker } from './runtime.js';

/**
 * ARB-015: "Retention period from T-06 enforced by scheduled job with test". The period
 * is T-06's and is not chosen here: org A is given 30 days by this test, org B none.
 * Real Redis for the schedule and the worker, real Postgres (PGlite) for the rows.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const THREAD_A = fixtureId('a', ENTITY.thread);
const THREAD_B = fixtureId('b', ENTITY.thread);
/** 23/09/2026 12:00 SAST. Thirty days before is 24/08/2026 10:00 UTC. */
const NOW = new Date('2026-09-23T10:00:00Z');

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
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
  await db.query(`update settings set retention_days = 30 where org_id = $1`, [ORG_A]);
  // Both orgs have a closed conversation last active on 01/08/2026, past 30 days.
  await db.query(
    `update threads set status = 'closed', last_message_at = '2026-08-01T08:00:00Z',
       client_handle = 'client-handle' where id = any($1)`,
    [[THREAD_A, THREAD_B]],
  );

  worker = startWorker('retention', retentionProcessor({ db, now: () => NOW }), {
    connection,
    prefix,
    deadLetter: queues[DEAD_LETTER_QUEUE],
  });
  events = new QueueEvents('retention', { connection, prefix });
  await events.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await db.close();
});

describe('the retention schedule', () => {
  it('is one daily scheduler at 00:00 UTC (02:00 SAST), however many processes start', async () => {
    await scheduleRetention(queues.retention);
    await scheduleRetention(queues.retention);
    const schedulers = await queues.retention.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: RETENTION_SCHEDULER_ID,
      name: 'purge',
      pattern: RETENTION_PATTERN,
    });
    // The next run is the coming midnight UTC.
    const next = new Date(Number(schedulers[0]?.next));
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
    await queues.retention.removeJobScheduler(RETENTION_SCHEDULER_ID);
  });
});

describe('a scheduled run, through the queue', () => {
  it('redacts the org with a period and stands down, saying so, for the org without', async () => {
    const job = await queues.retention.add('purge', {});
    const run = (await job.waitUntilFinished(events, 30_000)) as RetentionRun;

    expect(run).toMatchObject({
      ranAt: NOW.toISOString(),
      orgs: 2,
      purged: 1,
      skippedNoPeriod: 1,
      threads: 1,
    });
    expect(run.messages).toBeGreaterThan(0);

    const a = await db.query<{ body: string }>('select body from messages where thread_id = $1', [
      THREAD_A,
    ]);
    expect(a.rows.every((row) => row.body === REDACTED_TEXT)).toBe(true);
    const b = await db.query<{ body: string }>('select body from messages where thread_id = $1', [
      THREAD_B,
    ]);
    expect(b.rows.some((row) => row.body === REDACTED_TEXT)).toBe(false);

    const logged = await listEvents(db, { type: 'retention.purged' });
    const forB = logged.find((event) => event.org_id === ORG_B);
    expect(forB?.outcome).toBe('skipped');
    expect(JSON.stringify(forB?.payload)).toMatch(/T-06/);
    const forA = logged.find((event) => event.org_id === ORG_A);
    expect(forA?.outcome).toBe('ok');
    expect(forA?.payload).toMatchObject({ retention_days: 30, cutoff: '2026-08-24T10:00:00.000Z' });
  });

  it('a second run the same day finds nothing new to redact', async () => {
    const job = await queues.retention.add('purge', {});
    const run = (await job.waitUntilFinished(events, 30_000)) as RetentionRun;
    expect(run).toMatchObject({ purged: 1, skippedNoPeriod: 1, threads: 0, messages: 0 });
  });
});
