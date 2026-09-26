import { randomUUID } from 'node:crypto';
import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PRICE_REFRESH_PATTERN,
  PRICE_REFRESH_SCHEDULER_ID,
  priceRefreshProcessor,
  schedulePriceRefresh,
  type PriceRefreshRun,
} from './price-refresh.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-514: "The worker exists, is scheduled and is tested". Real Redis for the schedule
 * and the worker, real Postgres (PGlite) for the rows; the sampling rules themselves are
 * tested in packages/db/src/price-refresh.test.ts. The costs are test figures (D-14).
 */
const HOUSE = fixtureId('a', ENTITY.org);
const NOW = new Date('2026-09-26T10:00:00Z');

const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const prefix = `arb-test-${randomUUID()}`;
const queues = createQueues({ connection, prefix, attempts: 1, backoffMs: 10 });
let db: PGlite;
let worker: Worker;
let events: QueueEvents;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  await db.exec(`insert into service_categories (slug, name) values ('seo', 'SEO')`);
  // Five accepted SEO deliveries in the house org: R1 000 to R5 000.
  for (const [i, cost] of [100_000, 200_000, 300_000, 400_000, 500_000].entries()) {
    const job = await db.query<{ id: string }>(
      `insert into jobs (org_id, platform, external_id, raw, title, currency, category_slug)
       values ($1, 'freelancer', $2, '{}'::jsonb, 'A job', 'ZAR', 'seo') returning id`,
      [HOUSE, `job-${String(i)}`],
    );
    const item = await db.query<{ id: string }>(
      `insert into pipeline_items (org_id, job_id, stage) values ($1, $2, 'delivered') returning id`,
      [HOUSE, job.rows[0]!.id],
    );
    await db.query(
      `insert into delivery_orders
         (org_id, pipeline_item_id, status, agreed_cost_minor, currency, milestones, accepted_at)
       values ($1, $2, 'accepted', $3, 'ZAR', $4, '2026-09-01T08:00:00Z')`,
      [HOUSE, item.rows[0]!.id, cost, JSON.stringify([{ title: 'All', amountMinor: cost }])],
    );
  }

  worker = startWorker('price-refresh', priceRefreshProcessor({ db, now: () => NOW }), {
    connection,
    prefix,
    deadLetter: queues[DEAD_LETTER_QUEUE],
  });
  events = new QueueEvents('price-refresh', { connection, prefix });
  await events.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await db.close();
});

describe('the price-refresh schedule', () => {
  it('is one weekly scheduler, Mondays at 01:00 UTC (03:00 SAST), however many processes start', async () => {
    await schedulePriceRefresh(queues['price-refresh']);
    await schedulePriceRefresh(queues['price-refresh']);
    const schedulers = await queues['price-refresh'].getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: PRICE_REFRESH_SCHEDULER_ID,
      name: 'refresh',
      pattern: PRICE_REFRESH_PATTERN,
    });
    const next = new Date(Number(schedulers[0]?.next));
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    await queues['price-refresh'].removeJobScheduler(PRICE_REFRESH_SCHEDULER_ID);
  });
});

describe('a scheduled run, through the queue', () => {
  it('writes the band from the house org s deliveries and records the run', async () => {
    const job = await queues['price-refresh'].add('refresh', {});
    const run = (await job.waitUntilFinished(events, 30_000)) as PriceRefreshRun;
    expect(run).toMatchObject({
      ranAt: NOW.toISOString(),
      houseOrgs: 1,
      removed: 0,
      refreshed: [
        {
          categorySlug: 'seo',
          currency: 'ZAR',
          sampleSize: 5,
          p25Minor: '200000',
          p50Minor: '300000',
          p75Minor: '400000',
        },
      ],
    });
    const { rows } = await db.query<{ p50: string; sampled_at: Date }>(
      `select p50_minor::text as p50, sampled_at from market_price_bands
        where category_slug = 'seo' and source = 'completed_projects'`,
    );
    expect(rows).toEqual([{ p50: '300000', sampled_at: NOW }]);
    const logged = await listEvents(db, { type: 'price_bands.refreshed' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ org_id: HOUSE, outcome: 'ok', request_id: job.id });
  });
});
