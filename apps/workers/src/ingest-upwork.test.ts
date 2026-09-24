import { listEvents, putPlatformTokens } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { exchangeCode, upworkConfig, type UpworkConfig } from '@arbitron/upwork';
import { createFakeUpwork, sampleJob } from '@arbitron/upwork/fake';
import type { PGlite } from '@electric-sql/pglite';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeUpworkJobs } from './ingest-upwork.js';
import { pollScanner, syncIngestSchedules, type IngestDeps } from './ingest.js';

/**
 * ARB-300 acceptance, first clause: "Jobs ingested with source=upwork". The stand-in of
 * Upwork answers in the documented shapes (`@arbitron/upwork/fake`); the rows are real
 * Postgres (PGlite). The second clause, no browser automation, is
 * `tests/no-browser-automation.test.ts` and the CI step that runs its script.
 */
const ORG = fixtureId('a', ENTITY.org);
const ACCOUNT = fixtureId('e', 310);
const SCANNER = fixtureId('e', 311);
const NOW = new Date('2026-09-24T08:00:00Z');
let db: PGlite;
let config: UpworkConfig;
let fake: ReturnType<typeof createFakeUpwork>;

/** Enough of a BullMQ queue for the poll and the sync: what was added, and schedulers. */
class FakeQueue {
  readonly added: { name: string; data: unknown }[] = [];
  readonly schedulers = new Map<string, number>();
  add(name: string, data: unknown) {
    this.added.push({ name, data });
    return Promise.resolve({ id: name });
  }
  getJob() {
    return Promise.resolve(undefined);
  }
  getJobSchedulers() {
    return Promise.resolve([...this.schedulers].map(([key, every]) => ({ key, every })));
  }
  upsertJobScheduler(key: string, repeat: { every: number }) {
    this.schedulers.set(key, repeat.every);
    return Promise.resolve();
  }
  removeJobScheduler(key: string) {
    this.schedulers.delete(key);
    return Promise.resolve(true);
  }
}
let queue: FakeQueue;
let scoreQueue: FakeQueue;

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    db,
    queue: queue as unknown as Queue,
    config: null,
    upwork: config,
    fetch: fake.fetch,
    now: () => NOW,
    scoreQueue: scoreQueue as unknown as Queue,
    ...overrides,
  };
}

async function jobsOf(platform: string) {
  const { rows } = await db.query<{
    external_id: string;
    title: string;
    budget_min_minor: string | null;
    budget_max_minor: string | null;
    currency: string | null;
    hourly: boolean;
    bid_count: number | null;
    client_payment_verified: boolean | null;
    client_spend_minor: string | null;
    fetched_at: string;
  }>(
    `select external_id, title, budget_min_minor::text, budget_max_minor::text, currency, hourly,
            bid_count, client_payment_verified, client_spend_minor::text, fetched_at::text
       from jobs where org_id = $1 and platform = $2 order by external_id`,
    [ORG, platform],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  fake = createFakeUpwork();
  const result = upworkConfig({
    UPWORK_CLIENT_ID: 'client-id',
    UPWORK_CLIENT_SECRET: 'client-secret',
    APP_URL: 'http://localhost:5173',
    UPWORK_BASE_URL: fake.origin,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  await db.query(
    `insert into platform_accounts (id, org_id, platform, external_user_id, status) values ($1, $2, 'upwork', 'up-user-1', 'connected')`,
    [ACCOUNT, ORG],
  );
  const tokens = await exchangeCode(config, 'code-ok', { fetch: fake.fetch });
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt: new Date('2026-09-25T08:00:00Z') });
  await db.query(
    `insert into scanners (id, org_id, name, platform, filters, poll_interval_seconds)
     values ($1, $2, 'Upwork web builds', 'upwork', $3::jsonb, 300)`,
    [
      SCANNER,
      ORG,
      JSON.stringify({ keywords: ['sample'], budgetMinMinor: 20_000, currency: 'USD' }),
    ],
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  queue = new FakeQueue();
  scoreQueue = new FakeQueue();
  fake.state.jobs = [
    sampleJob(1),
    sampleJob(2, {
      amount: null,
      hourlyBudgetMin: { rawValue: '15.00', currency: 'USD' },
      hourlyBudgetMax: { rawValue: '35.50', currency: 'USD' },
      job: { contractTerms: { contractType: 'HOURLY' } },
      client: { verificationStatus: 'NOT_VERIFIED', totalSpent: null },
    }),
    // Under the scanner's USD 200,00 floor: dropped here, since the search cannot say it.
    sampleJob(3, { amount: { rawValue: '150', currency: 'USD' } }),
  ];
});

describe('an Upwork scanner’s poll', () => {
  it('stores each matching listing once with platform upwork, logs it and queues its score', async () => {
    const run = await pollScanner(deps(), { scannerId: SCANNER });
    expect(run).toMatchObject({ status: 'polled', fetched: 3, kept: 2, created: 2, updated: 0 });
    // USD 500,00 fixed; USD 15,00–35,50 an hour; applicants as the bid count.
    expect(await jobsOf('upwork')).toEqual([
      {
        external_id: '~01001',
        title: 'Sample Upwork job 1',
        budget_min_minor: '50000',
        budget_max_minor: '50000',
        currency: 'USD',
        hourly: false,
        bid_count: 3,
        client_payment_verified: true,
        client_spend_minor: '1234567',
        fetched_at: expect.stringMatching(/^2026-09-24 08:00:00/) as string,
      },
      {
        external_id: '~01002',
        title: 'Sample Upwork job 2',
        budget_min_minor: '1500',
        budget_max_minor: '3550',
        currency: 'USD',
        hourly: true,
        bid_count: 3,
        client_payment_verified: false,
        client_spend_minor: null,
        fetched_at: expect.stringMatching(/^2026-09-24 08:00:00/) as string,
      },
    ]);
    expect(scoreQueue.added.map((a) => a.name)).toEqual(['score', 'score']);
    const ingested = await listEvents(db, { type: 'job.ingested' });
    expect(ingested.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'upwork', external_id: '~01001' }),
      ]),
    );
    const call = (await listEvents(db, { type: 'external.call' }))[0];
    expect(call).toMatchObject({
      outcome: 'ok',
      payload: {
        service: 'upwork',
        doc: 'https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#query-marketplaceJobPostingsSearch',
      },
    });
    expect(JSON.stringify(await listEvents(db, {}))).not.toContain('access-');
    const sent = fake.state.calls.at(-1)!;
    expect(sent.body).toMatchObject({
      variables: { marketPlaceJobFilter: { searchExpression_eq: 'sample' } },
    });
  });

  it('a second poll refreshes the rows and their fetch time, and makes no duplicate', async () => {
    const later = new Date('2026-09-24T09:00:00Z');
    fake.state.jobs[0] = sampleJob(1, { title: 'Sample Upwork job 1, edited' });
    const run = await pollScanner(deps({ now: () => later }), { scannerId: SCANNER });
    expect(run).toMatchObject({ status: 'polled', created: 0, updated: 2 });
    const rows = await jobsOf('upwork');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('Sample Upwork job 1, edited');
    expect(rows[0]?.fetched_at).toMatch(/^2026-09-24 09:00:00/);
    expect(scoreQueue.added).toEqual([]);
  });

  it('is skipped, saying why, without the Upwork key or a connected account', async () => {
    expect(await pollScanner(deps({ upwork: null }), { scannerId: SCANNER })).toMatchObject({
      status: 'skipped',
      reason: 'Upwork is not configured (docs/02 B-14)',
    });
    await db.query(`update platform_accounts set status = 'revoked' where id = $1`, [ACCOUNT]);
    expect(await pollScanner(deps(), { scannerId: SCANNER })).toMatchObject({
      status: 'skipped',
      reason: 'the Upwork account is revoked; connect it again in Settings',
    });
    await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  });

  it('a rate limit is logged and thrown back for the queue to try again; the account stays connected', async () => {
    fake.state.rateLimitNext = true;
    await expect(pollScanner(deps(), { scannerId: SCANNER })).rejects.toMatchObject({
      status: 429,
    });
    const polled = (await listEvents(db, { type: 'scanner.polled' }))[0];
    expect(polled).toMatchObject({ outcome: 'error', payload: { retry: true } });
    const { rows } = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT],
    );
    expect(rows[0]?.status).toBe('connected');
  });

  it('a key without the job-search permission marks the account expired and says what to add', async () => {
    fake.state.permissionMissingNext = true;
    const run = await pollScanner(deps(), { scannerId: SCANNER });
    expect(run).toMatchObject({ status: 'auth_failed' });
    expect((run as { reason: string }).reason).toContain('"Read marketplace Job Postings"');
    const { rows } = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT],
    );
    expect(rows[0]?.status).toBe('expired');
    await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  });
});

describe('the sync', () => {
  it('schedules an Upwork scanner only with the key configured and the account connected', async () => {
    expect(await syncIngestSchedules(deps())).toMatchObject({ wanted: 1, added: 1 });
    expect([...queue.schedulers.keys()]).toEqual([`scanner:${SCANNER}`]);
    expect(await syncIngestSchedules(deps({ upwork: null }))).toMatchObject({
      wanted: 0,
      removed: 1,
    });
  });
});

describe('Upwork’s 24-hour rule', () => {
  it('deletes Upwork jobs not fetched within 24 hours, with their scores, and logs it; nothing else', async () => {
    const [kept, gone] = await jobsOf('upwork');
    await db.query(`update jobs set fetched_at = '2026-09-23T08:59:00Z' where external_id = $1`, [
      gone!.external_id,
    ]);
    await db.query(`update jobs set fetched_at = '2026-09-23T09:01:00Z' where external_id = $1`, [
      kept!.external_id,
    ]);
    // A Freelancer.com job fetched long ago is not Upwork's data: it stays.
    await db.query(
      `update jobs set fetched_at = '2026-09-20T00:00:00Z' where platform = 'freelancer'`,
    );
    const goneId = (
      await db.query<{ id: string }>('select id from jobs where external_id = $1', [
        gone!.external_id,
      ])
    ).rows[0]!.id;
    await db.query(
      `insert into job_scores (org_id, job_id, score, verdict, model) values ($1, $2, 50, 'caution', 'test')`,
      [ORG, goneId],
    );

    // 09:00 on the 24th: the cut-off is 09:00 on the 23rd.
    expect(await purgeUpworkJobs(db, new Date('2026-09-24T09:00:00Z'))).toBe(1);
    expect((await jobsOf('upwork')).map((j) => j.external_id)).toEqual([kept!.external_id]);
    expect(await jobsOf('freelancer')).toHaveLength(1);
    const scores = await db.query('select 1 from job_scores where job_id = $1', [goneId]);
    expect(scores.rows).toHaveLength(0);
    expect((await listEvents(db, { type: 'retention.purged' }))[0]).toMatchObject({
      org_id: ORG,
      payload: { platform: 'upwork', deleted: 1, cutoff: '2026-09-23T09:00:00.000Z' },
    });
    // The sync keeps the rule on every run.
    await db.query(`update jobs set fetched_at = '2026-09-22T00:00:00Z' where platform = 'upwork'`);
    expect(await syncIngestSchedules(deps())).toMatchObject({ purged: 1 });
  });
});
