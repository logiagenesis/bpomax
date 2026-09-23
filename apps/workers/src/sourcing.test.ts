import { insertBriefVersion, listEvents, lockBrief, putPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { exchangeCode, freelancerConfig, type FreelancerConfig } from '@arbitron/freelancer';
import { startFakeFreelancer, type FakeFreelancer } from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import { UnrecoverableError, type Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectAllSourcingBids,
  collectSourcingBids,
  postSourcingProject,
  type SourcingDeps,
} from './sourcing.js';

/**
 * ARB-203 acceptance: "Sandbox employer project created; candidate bids stored with
 * country and price". The sandbox half waits on B-03/B-04 (docs/BLOCKERS.md C-02); here
 * the stand-in of Freelancer.com answers over HTTP in the documented shapes, and the rows
 * are real Postgres (PGlite).
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const JOB = fixtureId('a', ENTITY.job);
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let deps: SourcingDeps;
let requestId: string;

async function post(fields: {
  platform?: string;
  approved?: boolean;
  budget?: [number | null, number | null];
  currency?: string | null;
}): Promise<string> {
  const [min, max] = fields.budget ?? [800000, 1200000];
  const { rows } = await db.query<{ id: string }>(
    `insert into sourcing_posts (org_id, sourcing_request_id, platform, title, body, budget_min_minor, budget_max_minor,
                                 currency, status, approved_by, approved_via)
     values ($1, $2, $3::platform, 'Shopify: An online shop', 'Scope only.', $4, $5, $6, $7::sourcing_post_status, $8, $9::approval_channel)
     returning id`,
    [
      ORG,
      requestId,
      fields.platform ?? 'freelancer',
      min,
      max,
      fields.currency === undefined ? 'ZAR' : fields.currency,
      fields.approved === false ? 'draft' : 'approved',
      fields.approved === false ? null : OWNER,
      fields.approved === false ? null : 'web',
    ],
  );
  return rows[0]!.id;
}
async function setLive(orgLive: boolean): Promise<void> {
  await db.query(
    `update settings set live_mode = $2, min_margin_pct = 20, min_margin_zar_minor = 50000,
       fx_buffer_pct = 3, retention_days = 365,
       fee_table = '[{"platform":"freelancer","project_type":"fixed","side":"freelancer","percent":10,"source_url":"https://example.test/fees","read_on":"2026-09-22"}]'::jsonb
     where org_id = $1`,
    [ORG, orgLive],
  );
}
const row = async (id: string) =>
  (
    await db.query<{ status: string; external_id: string | null; failure_reason: string | null }>(
      'select status::text as status, external_id, failure_reason from sourcing_posts where id = $1',
      [id],
    )
  ).rows[0]!;
const creates = () =>
  fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/projects/0.1/projects/');

beforeAll(async () => {
  db = await createTestDatabase();
  for (const r of identityRows('a')) await db.exec(r.sql);
  for (const r of tenantRows(ORG, 'a', 'a')) {
    if (['memberships', 'platform_accounts', 'jobs', 'settings'].includes(r.table))
      await db.exec(r.sql);
  }
  await db.query(
    `insert into service_categories (slug, name, sort_order) values ('shopify', 'Shopify', 4) on conflict (slug) do nothing`,
  );
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG, JOB],
  );
  const brief = await insertBriefVersion(db, {
    orgId: ORG,
    threadId: t.rows[0]!.id,
    brief: {
      title: 'Shop',
      outcome: 'An online shop',
      users: null,
      mustHaves: ['Checkout'],
      later: [],
      references: [],
      assetsProvided: [],
      assetsMissing: [],
      techConstraints: [],
      deadline: null,
      deadlineFixed: null,
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      acceptanceCriteria: ['Orders go through'],
      signOff: { name: null, responseTime: null },
      risks: [],
      category: 'shopify',
      deliveryRoute: 'supplier',
    },
  });
  const locked = await lockBrief(db, brief, NOW);
  if (!locked.ok) throw new Error('fixture brief should lock');
  const r = await db.query<{ id: string }>(
    `insert into sourcing_requests (org_id, brief_id) values ($1, $2) returning id`,
    [ORG, locked.brief.id],
  );
  requestId = r.rows[0]!.id;

  fake = await startFakeFreelancer();
  fake.setCurrencies([
    { id: 1, code: 'USD' },
    { id: 30, code: 'ZAR' },
  ]);
  fake.setJobs([
    { id: 1001, name: 'Shopify' },
    { id: 1002, name: 'Shopify Templates' },
  ]);
  fake.setBidders([
    { id: 501, username: 'thandi-web', country_code: 'ZA' },
    { id: 502, username: 'kolkata-devs', country_code: 'IN' },
  ]);
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt: new Date('2026-10-23T10:00:00Z') });
  deps = { db, liveMode: false, config, now: () => NOW };
}, 60_000);

afterAll(async () => {
  await fake.close();
  await db.close();
});

describe('posting an approved Freelancer.com post', () => {
  it('an unapproved post and an Upwork post are never sent', async () => {
    await setLive(true);
    const draft = await post({ approved: false });
    expect(await postSourcingProject({ ...deps, liveMode: true }, { postId: draft })).toMatchObject(
      {
        status: 'skipped',
        reason: 'not_approved',
      },
    );
    const upwork = await post({ platform: 'upwork' });
    expect(
      await postSourcingProject({ ...deps, liveMode: true }, { postId: upwork }),
    ).toMatchObject({
      status: 'skipped',
      reason: 'not_freelancer',
    });
    expect(creates()).toHaveLength(0);
  });

  it('with either switch off, nothing is posted and the audit log shows what would have gone', async () => {
    await setLive(true);
    const id = await post({});
    expect(await postSourcingProject(deps, { postId: id })).toMatchObject({
      status: 'blocked',
      reason: 'live_mode_off',
    });
    await setLive(false);
    expect(await postSourcingProject({ ...deps, liveMode: true }, { postId: id })).toMatchObject({
      status: 'blocked',
    });
    expect(creates()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: 'approved', external_id: null });
    const blocked = await listEvents(db, { type: 'external.blocked_by_live_mode' });
    // Hand-worked: R8 000,00 to R12 000,00 is 8000 to 12000 in the currency's units.
    expect(blocked[0]?.payload).toMatchObject({
      wouldSend: {
        title: 'Shopify: An online shop',
        currency: 'ZAR',
        budget: { minimum: 8000, maximum: 12000 },
        skill: 'Shopify',
      },
    });
  });

  it('with both switches on, creates the project with the documented body and records its id', async () => {
    await setLive(true);
    const id = await post({});
    const result = await postSourcingProject({ ...deps, liveMode: true }, { postId: id });
    expect(result).toMatchObject({ status: 'posted', externalId: '16000001' });
    expect(creates().at(-1)?.json).toEqual({
      title: 'Shopify: An online shop',
      description: 'Scope only.',
      currency: { id: 30 },
      budget: { minimum: 8000, maximum: 12000 },
      jobs: [{ id: 1001 }],
    });
    expect(await row(id)).toMatchObject({
      status: 'posted',
      external_id: '16000001',
      failure_reason: null,
    });
    expect(await postSourcingProject({ ...deps, liveMode: true }, { postId: id })).toEqual({
      status: 'already_posted',
      externalId: '16000001',
    });
    expect(creates()).toHaveLength(1);
    const posted = await listEvents(db, { type: 'sourcing.posted' });
    expect(posted.find((e) => e.outcome === 'ok')?.payload).toMatchObject({
      external_id: '16000001',
    });
  });

  it('fails with the reason when the post has no budget or the currency is not listed', async () => {
    const noBudget = await post({ budget: [null, null] });
    expect(
      await postSourcingProject({ ...deps, liveMode: true }, { postId: noBudget }),
    ).toMatchObject({
      status: 'failed',
      reason: 'no_budget',
    });
    expect(await row(noBudget)).toMatchObject({ status: 'failed' });
    const eur = await post({ currency: 'EUR' });
    expect(await postSourcingProject({ ...deps, liveMode: true }, { postId: eur })).toMatchObject({
      status: 'failed',
      reason: 'no_currency',
      message: 'Freelancer.com lists no currency EUR, so the project is not posted.',
    });
    expect(creates()).toHaveLength(1);
  });

  it('a refusal the platform will not change its mind about is final and recorded on the post', async () => {
    const id = await post({});
    fake.setJobs([]);
    expect(await postSourcingProject({ ...deps, liveMode: true }, { postId: id })).toMatchObject({
      status: 'failed',
      reason: 'no_skill',
    });
    fake.setJobs([{ id: 1001, name: 'Shopify' }]);
    const other = await post({});
    fake.expireAccessTokens();
    await expect(
      postSourcingProject({ ...deps, liveMode: true }, { postId: other }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await row(other)).status).toBe('failed');
    expect((await row(other)).failure_reason).toContain('Edit the post and approve it again.');
  });
});

describe('collecting the bids', () => {
  it('stores each bid once with the bidder’s country and the price in minor units, and updates it when read again', async () => {
    const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
    await putPlatformTokens(db, ACCOUNT, {
      ...tokens,
      expiresAt: new Date('2026-10-23T10:00:00Z'),
    });
    const posted = (
      await db.query<{ id: string }>(`select id from sourcing_posts where external_id = '16000001'`)
    ).rows[0]!.id;
    fake.setBids(16000001, [
      { id: 901, bidder_id: 501, amount: 9000.5, period: 5 },
      { id: 902, bidder_id: 502, amount: 7500, period: 14 },
    ]);
    // ARB-204: a new bid, or a changed price, is handed to the reprice queue; nothing else is.
    const queued: { data: unknown; jobId: string | undefined }[] = [];
    const repriceQueue = {
      add: (_name: string, data: unknown, opts?: { jobId?: string }) => {
        queued.push({ data, jobId: opts?.jobId });
        return Promise.resolve({});
      },
    } as unknown as Queue;
    const withReprice = { ...deps, repriceQueue };
    expect(await collectSourcingBids(withReprice, { postId: posted })).toEqual({
      status: 'collected',
      added: 2,
      updated: 0,
    });
    const candidates = async () =>
      (
        await db.query<{
          display_name: string;
          country_code: string | null;
          quoted_price_minor: string;
          currency: string;
          turnaround_days: number;
          external_bid_id: string;
          sourcing_post_id: string;
        }>(
          `select display_name, country_code, quoted_price_minor::text as quoted_price_minor, currency::text as currency,
                  turnaround_days, external_bid_id, sourcing_post_id
             from supplier_candidates where sourcing_request_id = $1 order by external_bid_id`,
          [requestId],
        )
      ).rows;
    // Hand-worked: R9 000,50 is 900 050 cents; R7 500 is 750 000 cents.
    expect(await candidates()).toEqual([
      {
        display_name: 'thandi-web',
        country_code: 'ZA',
        quoted_price_minor: '900050',
        currency: 'ZAR',
        turnaround_days: 5,
        external_bid_id: '901',
        sourcing_post_id: posted,
      },
      {
        display_name: 'kolkata-devs',
        country_code: 'IN',
        quoted_price_minor: '750000',
        currency: 'ZAR',
        turnaround_days: 14,
        external_bid_id: '902',
        sourcing_post_id: posted,
      },
    ]);
    fake.setBids(16000001, [
      { id: 901, bidder_id: 501, amount: 8800, period: 4 },
      { id: 902, bidder_id: 502, amount: 7500, period: 14 },
    ]);
    expect(await collectAllSourcingBids(withReprice)).toEqual({ posts: 1 });
    expect((await candidates())[0]).toMatchObject({
      quoted_price_minor: '880000',
      turnaround_days: 4,
    });
    const ids = (
      await db.query<{ id: string; external_bid_id: string }>(
        `select id, external_bid_id from supplier_candidates where sourcing_request_id = $1 order by external_bid_id`,
        [requestId],
      )
    ).rows.map((r) => r.id);
    expect(queued.map((q) => q.jobId)).toEqual([
      `reprice__${ids[0]!}__900050`,
      `reprice__${ids[1]!}__750000`,
      `reprice__${ids[0]!}__880000`,
    ]);
    expect(queued[0]?.data).toEqual({ candidateId: ids[0] });
    expect(await candidates()).toHaveLength(2);
    expect(await listEvents(db, { type: 'supplier.candidate_added' })).toHaveLength(2);
  });

  it('a post that is not a posted Freelancer.com project has nothing to read', async () => {
    const draft = await post({ approved: false });
    expect(await collectSourcingBids(deps, { postId: draft })).toMatchObject({
      status: 'skipped',
      added: 0,
    });
  });
});
