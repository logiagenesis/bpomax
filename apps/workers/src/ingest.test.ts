import { randomUUID } from 'node:crypto';
import { listEvents, putPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { exchangeCode, freelancerConfig, type FreelancerConfig } from '@arbitron/freelancer';
import {
  startFakeFreelancer,
  type FakeFreelancer,
  type FakeProject,
} from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INGEST_SYNC_EVERY_MS,
  INGEST_SYNC_SCHEDULER_ID,
  buildQuery,
  ingestProcessor,
  pollScanner,
  scannerSchedulerId,
  scheduleIngestSync,
  syncIngestSchedules,
  usdText,
  type IngestDeps,
  type IngestRun,
} from './ingest.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-022: "New matching sandbox/live-read jobs appear within one interval; zero
 * duplicates after 24 h run". Real Redis for the schedules and the worker, real Postgres
 * (PGlite) for the rows, and the stand-in of Freelancer.com over HTTP for the search.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const ACCOUNT_A = fixtureId('a', ENTITY.platformAccount);
const ACCOUNT_B = fixtureId('b', ENTITY.platformAccount);
const SCANNER_A = fixtureId('a', ENTITY.scanner);
const SCANNER_B = fixtureId('b', ENTITY.scanner);
const SCANNER_ZAR = '00000000-0000-4000-8000-0000000000aa';
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
const POSTED = Math.floor(Date.parse('2026-09-23T08:00:00Z') / 1000);

const PROJECTS: FakeProject[] = [
  {
    id: 15791512,
    title: 'Shopify store rebuild',
    preview_description: 'Rebuild our Shopify store',
    description: 'Rebuild our Shopify store with a new theme and a faster checkout.',
    type: 'fixed',
    budget: { minimum: 250, maximum: 750 },
    currency: { code: 'USD', id: 1 },
    jobs: [
      { id: 17, name: 'Website Design', seo_url: 'website-design' },
      { id: 600, name: 'Shopify', seo_url: 'shopify' },
    ],
    bid_stats: { bid_count: 33, bid_avg: 462.57575757575756 },
    time_submitted: POSTED,
    time_updated: POSTED + 60,
    status: 'active',
    seo_url: 'shopify/Shopify-store-rebuild',
    location: { country: { code: 'ZA' } },
  },
  {
    id: 15745863,
    title: 'Port a Shopify store to WooCommerce',
    preview_description: 'Port our shop',
    description: 'Port our Shopify shop to WooCommerce, keeping every product.',
    type: 'fixed',
    budget: { minimum: 30, maximum: 250 },
    currency: { code: 'USD', id: 1 },
    jobs: [{ id: 3, name: 'PHP', seo_url: 'php' }],
    bid_stats: { bid_count: 16, bid_avg: 276.1875 },
    time_submitted: POSTED - 3600,
    time_updated: POSTED - 3000,
    status: 'active',
    seo_url: 'php/Port-Shopify-store-WooCommerce',
    location: { country: { code: 'ZA' } },
  },
  {
    id: 15730326,
    title: 'WordPress maintenance, hourly',
    preview_description: 'Ongoing WordPress work',
    description: 'Ongoing WordPress maintenance for a small agency.',
    type: 'hourly',
    budget: { minimum: 50 },
    currency: { code: 'USD', id: 1 },
    jobs: [{ id: 4, name: 'WordPress', seo_url: 'wordpress' }],
    bid_stats: { bid_count: 13, bid_avg: 53.2 },
    time_submitted: POSTED - 7200,
    time_updated: POSTED - 7000,
    status: 'active',
    seo_url: 'wordpress/WordPress-maintenance',
    location: { country: { code: 'ZA' } },
  },
  {
    id: 15730327,
    title: 'Shopify theme tweaks',
    preview_description: 'Small Shopify theme changes',
    description: 'Small Shopify theme changes for a store in Pune.',
    type: 'fixed',
    budget: { minimum: 1500, maximum: 5000 },
    currency: { code: 'INR', id: 11 },
    jobs: [{ id: 600, name: 'Shopify', seo_url: 'shopify' }],
    bid_stats: { bid_count: 5, bid_avg: 2200 },
    time_submitted: POSTED - 100,
    time_updated: POSTED - 50,
    status: 'active',
    seo_url: 'shopify/Shopify-theme-tweaks',
    location: { country: { code: 'IN' } },
  },
];

const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const prefix = `arb-test-${randomUUID()}`;
const queues = createQueues({ connection, prefix, attempts: 2, backoffMs: 10 });
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let deps: IngestDeps;
let worker: Worker;
let events: QueueEvents;

async function connect(accountId: string): Promise<void> {
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [accountId]);
  await putPlatformTokens(db, accountId, {
    ...tokens,
    expiresAt: new Date('2026-10-23T10:00:00Z'),
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const rows of [tenantRows(ORG_A, 'a', 'a'), tenantRows(ORG_B, 'b', 'b')]) {
    for (const row of rows) {
      if (['memberships', 'platform_accounts', 'scanners'].includes(row.table)) {
        await db.exec(row.sql);
      }
    }
  }
  // Org B's account is there but not connected; 0002's fixture default is `connected`.
  await db.query(`update platform_accounts set status = 'disconnected' where id = $1`, [ACCOUNT_B]);
  await db.query(
    `update scanners set filters = $2::jsonb, poll_interval_seconds = 60 where id = $1`,
    [
      SCANNER_A,
      JSON.stringify({
        keywords: ['shopify'],
        hourly: false,
        clientCountriesInclude: ['ZA'],
        clientCountriesExclude: ['RU'],
        categorySlugs: ['shopify'],
      }),
    ],
  );
  await db.query(
    `insert into scanners (id, org_id, name, filters)
     values ($1, $2, 'Rand floor', '{"budgetMinMinor": 10000, "currency": "ZAR"}'::jsonb)`,
    [SCANNER_ZAR, ORG_A],
  );

  fake = await startFakeFreelancer();
  fake.setProjects(PROJECTS);
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  await connect(ACCOUNT_A);

  deps = { db, queue: queues.ingest, config, now: () => NOW, scoreQueue: queues.score };
  worker = startWorker('ingest', ingestProcessor(deps), {
    connection,
    prefix,
    deadLetter: queues[DEAD_LETTER_QUEUE],
  });
  events = new QueueEvents('ingest', { connection, prefix });
  await events.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
  await closeQueues(queues);
  await fake.close();
  await db.close();
});

const searchCalls = () => fake.calls.filter((c) => c.path === '/api/projects/0.1/projects/active/');

describe('the schedules', () => {
  // A scheduler adds its first job at once; paused, the worker leaves them for the drain.
  beforeAll(() => queues.ingest.pause());
  afterAll(async () => {
    await queues.ingest.drain(true);
    await queues.ingest.resume();
  });

  it('one sync scheduler every minute, however many processes start', async () => {
    await scheduleIngestSync(queues.ingest);
    await scheduleIngestSync(queues.ingest);
    const schedulers = await queues.ingest.getJobSchedulers();
    const sync = schedulers.filter((s) => s.key === INGEST_SYNC_SCHEDULER_ID);
    expect(sync).toHaveLength(1);
    expect(String(sync[0]?.every)).toBe(String(INGEST_SYNC_EVERY_MS));
    await queues.ingest.removeJobScheduler(INGEST_SYNC_SCHEDULER_ID);
  });

  it('the sync keeps one scheduler per active scanner of a connected org, at its interval, and drops the rest', async () => {
    // Org A is connected with two active scanners; org B has no connected account.
    expect(await syncIngestSchedules(deps)).toEqual({
      wanted: 2,
      added: 2,
      changed: 0,
      removed: 0,
    });
    let keys = (await queues.ingest.getJobSchedulers()).map((s) => [s.key, String(s.every)]);
    expect(keys).toEqual(
      expect.arrayContaining([
        [scannerSchedulerId(SCANNER_A), '60000'],
        [scannerSchedulerId(SCANNER_ZAR), '120000'],
      ]),
    );
    expect(keys.some(([key]) => key === scannerSchedulerId(SCANNER_B))).toBe(false);

    // A second sync changes nothing; an edited interval is picked up; a paused scanner goes.
    expect(await syncIngestSchedules(deps)).toEqual({
      wanted: 2,
      added: 0,
      changed: 0,
      removed: 0,
    });
    await db.query(`update scanners set poll_interval_seconds = 300 where id = $1`, [SCANNER_ZAR]);
    expect(await syncIngestSchedules(deps)).toMatchObject({ changed: 1 });
    await db.query(`update scanners set active = false where id = $1`, [SCANNER_ZAR]);
    expect(await syncIngestSchedules(deps)).toEqual({
      wanted: 1,
      added: 0,
      changed: 0,
      removed: 1,
    });
    keys = (await queues.ingest.getJobSchedulers()).map((s) => [s.key, String(s.every)]);
    expect(keys).toEqual([[scannerSchedulerId(SCANNER_A), '60000']]);
    await db.query(`update scanners set active = true where id = $1`, [SCANNER_ZAR]);
    await queues.ingest.removeJobScheduler(scannerSchedulerId(SCANNER_A));
  });

  it('without the Freelancer.com settings nothing is scheduled, and the sync says why', async () => {
    await queues.ingest.upsertJobScheduler(
      scannerSchedulerId(SCANNER_A),
      { every: 60_000 },
      {
        name: 'poll',
        data: { kind: 'poll', scannerId: SCANNER_A },
      },
    );
    const sync = await syncIngestSchedules({ ...deps, config: null });
    expect(sync).toMatchObject({ wanted: 0, removed: 1 });
    expect(sync.reason).toMatch(/B-03/);
    expect(await queues.ingest.getJobSchedulers()).toEqual([]);
  });
});

describe('the scanner filters as the documented parameters', () => {
  it('keywords, type and countries go to the endpoint; what it cannot take is named', () => {
    const built = buildQuery({
      keywords: ['shopify', ' woocommerce '],
      hourly: true,
      clientCountriesInclude: ['ZA', 'GB'],
      clientCountriesExclude: ['RU'],
      categorySlugs: ['shopify'],
      budgetMinMinor: 25000,
      currency: 'USD',
    });
    expect(built.query).toEqual({
      query: 'shopify woocommerce',
      projectTypes: ['hourly'],
      countries: ['ZA', 'GB'],
      minPriceUsd: '250.00',
    });
    expect(built.notApplied).toEqual(['clientCountriesExclude', 'categorySlugs']);
    expect(usdText(1)).toBe('0.01');
    expect(usdText(123456)).toBe('1234.56');
  });

  it('a budget floor in another currency is applied here, to listings in that currency only', () => {
    const built = buildQuery({ budgetMinMinor: 10000, currency: 'ZAR' });
    expect(built.query).toEqual({});
    const listing = (currencyCode: string | null, budgetMinimum: number | null) =>
      ({ currencyCode, budgetMinimum }) as never;
    expect(built.keep(listing('ZAR', 50))).toBe(false);
    expect(built.keep(listing('ZAR', 100))).toBe(true);
    expect(built.keep(listing('USD', 5))).toBe(true);
    expect(built.keep(listing(null, null))).toBe(true);
  });
});

describe('a poll', () => {
  it('asks Freelancer.com with the scanner filters, upserts the matching listings, logs each and queues a score', async () => {
    const run = await pollScanner(deps, { scannerId: SCANNER_A, requestId: 'req-1' });
    expect(run).toMatchObject({
      status: 'polled',
      orgId: ORG_A,
      fetched: 2,
      kept: 2,
      created: 2,
      updated: 0,
      totalCount: 2,
    });

    const call = searchCalls().at(-1)!;
    expect(call.query).toMatchObject({
      query: 'shopify',
      sort_field: 'time_updated',
      limit: '100',
      full_description: 'true',
      job_details: 'true',
    });
    expect(call.queryAll['project_types[]']).toEqual(['fixed']);
    expect(call.queryAll['countries[]']).toEqual(['za']);
    expect(call.query).not.toHaveProperty('min_price');

    const jobs = await db.query<{
      external_id: string;
      title: string;
      description: string;
      budget_min_minor: string;
      budget_max_minor: string;
      currency: string;
      hourly: boolean;
      skills: string[];
      bid_count: number;
      average_bid_minor: string | null;
      posted_at: string;
      scanner_id: string;
      raw: { seo_url: string };
    }>(
      `select external_id, title, description, budget_min_minor::text, budget_max_minor::text,
              currency, hourly, skills, bid_count, average_bid_minor::text, posted_at, scanner_id, raw
         from jobs where org_id = $1 order by external_id`,
      [ORG_A],
    );
    expect(jobs.rows.map((row) => row.external_id)).toEqual(['15745863', '15791512']);
    expect(jobs.rows[1]).toMatchObject({
      title: 'Shopify store rebuild',
      description: 'Rebuild our Shopify store with a new theme and a faster checkout.',
      // Hand-worked: USD 250 and USD 750 are 25 000 and 75 000 cents.
      budget_min_minor: '25000',
      budget_max_minor: '75000',
      currency: 'USD',
      hourly: false,
      skills: ['Website Design', 'Shopify'],
      bid_count: 33,
      // The docs do not say which currency bid_avg is in, so no figure is made of it.
      average_bid_minor: null,
      scanner_id: SCANNER_A,
    });
    expect(new Date(jobs.rows[1]!.posted_at).toISOString()).toBe('2026-09-23T08:00:00.000Z');
    expect(jobs.rows[1]!.raw.seo_url).toBe('shopify/Shopify-store-rebuild');

    const calls = await listEvents(db, { type: 'external.call' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ org_id: ORG_A, outcome: 'ok', request_id: 'req-1' });
    expect(calls[0]?.payload).toMatchObject({
      service: 'freelancer',
      call: 'projects/0.1/projects/active',
      total_count: 2,
      returned: 2,
      rate_limit: { remaining: 45 },
    });
    expect(JSON.stringify(calls[0]?.payload)).not.toMatch(/access-/);

    const ingested = await listEvents(db, { type: 'job.ingested' });
    expect(ingested).toHaveLength(2);
    expect(ingested.map((e) => (e.payload as { external_id: string }).external_id).sort()).toEqual([
      '15745863',
      '15791512',
    ]);
    const polled = await listEvents(db, { type: 'scanner.polled' });
    expect(polled).toHaveLength(1);
    expect(polled[0]?.payload).toMatchObject({
      created: 2,
      updated: 0,
      filters_not_applied: ['clientCountriesExclude', 'categorySlugs'],
    });

    const ids = await db.query<{ id: string }>(
      'select id from jobs where org_id = $1 order by id',
      [ORG_A],
    );
    const scores = await queues.score.getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(scores.map((job) => (job.data as { jobId: string }).jobId).sort()).toEqual(
      ids.rows.map((row) => row.id),
    );
    const account = await db.query<{ last_sync_at: string }>(
      'select last_sync_at from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(new Date(account.rows[0]!.last_sync_at).toISOString()).toBe(NOW.toISOString());
  });

  it('a second poll of the same listings makes no duplicate and queues nothing new', async () => {
    fake.setProjects(
      PROJECTS.map((p) =>
        p.id === 15791512 ? { ...p, bid_stats: { bid_count: 41, bid_avg: 470 } } : p,
      ),
    );
    const run = await pollScanner(deps, { scannerId: SCANNER_A });
    expect(run).toMatchObject({ status: 'polled', created: 0, updated: 2 });
    const count = await db.query<{ n: number }>(
      'select count(*)::int as n from jobs where org_id = $1',
      [ORG_A],
    );
    expect(count.rows[0]?.n).toBe(2);
    const bids = await db.query<{ bid_count: number }>(
      `select bid_count from jobs where org_id = $1 and external_id = '15791512'`,
      [ORG_A],
    );
    expect(bids.rows[0]?.bid_count).toBe(41);
    expect(await listEvents(db, { type: 'job.ingested' })).toHaveLength(2);
    const scores = await queues.score.getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(scores).toHaveLength(2);
  });

  it('a rand floor keeps listings in other currencies and drops the rand ones below it', async () => {
    fake.setProjects([
      ...PROJECTS,
      {
        id: 15730400,
        title: 'Cheap rand job',
        preview_description: 'Small job',
        type: 'fixed',
        budget: { minimum: 50, maximum: 90 },
        currency: { code: 'ZAR', id: 27 },
        time_submitted: POSTED,
        time_updated: POSTED,
      },
    ]);
    const run = await pollScanner(deps, { scannerId: SCANNER_ZAR });
    expect(run).toMatchObject({ status: 'polled', fetched: 5, kept: 4 });
    const cheap = await db.query(
      `select 1 from jobs where org_id = $1 and external_id = '15730400'`,
      [ORG_A],
    );
    expect(cheap.rows).toHaveLength(0);
    fake.setProjects(PROJECTS);
  });

  it('a rate limit is logged with the documented code and the job goes back to the queue, which tries again', async () => {
    // `events` is append-only (0007), so the run is read as the newest entries.
    const before = (await listEvents(db, { type: 'external.call' })).length;
    fake.rateLimitNextCalls(1);
    const job = await queues.ingest.add('poll', { kind: 'poll', scannerId: SCANNER_A });
    const run = (await job.waitUntilFinished(events, 30_000)) as IngestRun;
    expect(run).toMatchObject({ status: 'polled', created: 0, updated: 2 });

    const calls = await listEvents(db, { type: 'external.call' });
    expect(calls).toHaveLength(before + 2);
    expect(calls.slice(0, 2).map((c) => c.outcome)).toEqual(['ok', 'error']);
    const refused = calls[1];
    expect(refused?.payload).toMatchObject({
      status: 429,
      error_code: 'AuthorisationExceptionCodes.RATE_LIMITED',
      rate_limit: { remaining: 0 },
    });
    const polled = await listEvents(db, { type: 'scanner.polled' });
    expect(polled.slice(0, 2).map((p) => p.outcome)).toEqual(['ok', 'error']);
    expect(polled[1]?.payload).toMatchObject({ retry: true });
    expect(await queues[DEAD_LETTER_QUEUE].count()).toBe(0);
  });

  it('an org with no connected account is skipped, saying so', async () => {
    const run = await pollScanner(deps, { scannerId: SCANNER_B });
    expect(run).toMatchObject({ status: 'skipped' });
    expect((run as { reason: string }).reason).toMatch(/connect/i);
    const polled = await listEvents(db, { type: 'scanner.polled' });
    expect(polled.find((p) => p.org_id === ORG_B)).toMatchObject({ outcome: 'skipped' });
  });

  it('two orgs each hold their own row for the same listing (0018)', async () => {
    await connect(ACCOUNT_B);
    const run = await pollScanner(deps, { scannerId: SCANNER_B });
    expect(run).toMatchObject({ status: 'polled', created: 4 });
    const shared = await db.query<{ org_id: string }>(
      `select org_id from jobs where external_id = '15791512' order by org_id`,
      [],
    );
    expect(shared.rows.map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);
  });

  it('a deleted or paused scanner is skipped and its schedule removed', async () => {
    const gone = '00000000-0000-4000-8000-0000000000bb';
    await queues.ingest.upsertJobScheduler(
      scannerSchedulerId(gone),
      { every: 60_000 },
      {
        name: 'poll',
        data: { kind: 'poll', scannerId: gone },
      },
    );
    expect(await pollScanner(deps, { scannerId: gone })).toMatchObject({
      status: 'skipped',
      reason: 'the scanner no longer exists',
    });
    expect(
      (await queues.ingest.getJobSchedulers()).some((s) => s.key === scannerSchedulerId(gone)),
    ).toBe(false);
  });

  it('a refused token marks the account expired and is not tried again', async () => {
    fake.expireAccessTokens();
    const run = await pollScanner(deps, { scannerId: SCANNER_A });
    expect(run).toMatchObject({ status: 'auth_failed', orgId: ORG_A });
    const account = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(account.rows[0]?.status).toBe('expired');
    const calls = await listEvents(db, { type: 'external.call' });
    expect(calls[0]).toMatchObject({ outcome: 'error' });
    expect(calls[0]?.payload).toMatchObject({ status: 401 });
    // The next poll stands down until the owner connects again.
    expect(await pollScanner(deps, { scannerId: SCANNER_A })).toMatchObject({ status: 'skipped' });
  });
});
