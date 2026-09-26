import { randomUUID } from 'node:crypto';
import type { BidPayload } from '@arbitron/core';
import { putPlatformTokens, type Queryable } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { exchangeCode, freelancerConfig, type FreelancerConfig } from '@arbitron/freelancer';
import { startFakeFreelancer, type FakeFreelancer } from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freelancerBidPlacer, milestonePercentage } from './bid-placer.js';
import { submitProposal } from './submit.js';

/**
 * ARB-511, the owner's audit E-04 and E-05: "Sandbox bid returns a platform ref with a
 * matching event" (against the stand-in until C-02) and "A fault test (crash after
 * platform 200) does not double-send".
 */
const ORG = fixtureId('a', ENTITY.org);
const USER = fixtureId('a', ENTITY.user);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const REDIRECT = 'https://app.example.test/freelancer-callback.html';
const ME = 1_000_001;
const NOW = new Date('2026-09-26T12:00:00Z');
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;

async function insertJob(externalId: string, currency = 'USD'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, budget_max_minor, currency)
     values ($1, 'freelancer', $2, '{}'::jsonb, 'A job', 500000, $3) returning id`,
    [ORG, externalId, currency],
  );
  return rows[0]!.id;
}

async function insertProposal(jobId: string, currency = 'USD'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals
       (org_id, job_id, body, amount_minor, currency, delivery_days, milestones, status, approved_by, approved_via)
     values ($1, $2, 'Thanks for the brief.', 450000, $3, 7,
             '[{"title":"Design","amount_minor":150000},{"title":"Build","amount_minor":300000}]'::jsonb,
             'approved', $4, 'web')
     returning id`,
    [ORG, jobId, currency, USER],
  );
  return rows[0]!.id;
}

function payload(proposalId: string, jobExternalId: string, currency = 'USD'): BidPayload {
  return {
    action: 'place_bid',
    platform: 'freelancer',
    jobExternalId,
    proposalId,
    amountMinor: 450_000,
    currency,
    deliveryDays: 7,
    milestones: [
      { title: 'Design', amount_minor: 150_000 },
      { title: 'Build', amount_minor: 300_000 },
    ],
    body: 'Thanks for the brief.',
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  fake = await startFakeFreelancer();
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(
    `update platform_accounts set status = 'connected', external_user_id = $2,
       plan_name = 'Test plan', monthly_bid_allowance = 100 where id = $1`,
    [ACCOUNT, String(ME)],
  );
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt: new Date('2026-10-26T12:00:00Z') });
  await db.query(
    `update settings set live_mode = true, min_margin_pct = 20, min_margin_zar_minor = 50000,
       fx_buffer_pct = 3, retention_days = 365,
       fee_table = '[{"platform":"freelancer","project_type":"fixed","side":"freelancer","percent":10,"source_url":"https://example.test/fees","read_on":"2026-09-22"}]'::jsonb
     where org_id = $1`,
    [ORG],
  );
}, 60_000);

afterAll(async () => {
  await fake.close();
  await db.close();
});

describe('milestonePercentage (D-077)', () => {
  it("is the first milestone's share, rounded down to a whole percent, or 100 without milestones", () => {
    expect(milestonePercentage({ amountMinor: 450_000, milestones: [] })).toBe(100);
    expect(
      milestonePercentage({
        amountMinor: 450_000,
        milestones: [
          { title: 'a', amount_minor: 150_000 },
          { title: 'b', amount_minor: 300_000 },
        ],
      }),
    ).toBe(33);
    expect(
      milestonePercentage({
        amountMinor: 450_000,
        milestones: [{ title: 'a', amount_minor: 450_000 }],
      }),
    ).toBe(100);
    expect(
      milestonePercentage({
        amountMinor: 1_000_000,
        milestones: [
          { title: 'a', amount_minor: 1 },
          { title: 'b', amount_minor: 999_999 },
        ],
      }),
    ).toBe(1);
  });
});

describe('the Freelancer.com placer', () => {
  it('places the bid in the project currency units, as the bidder, with the proposal text', async () => {
    const jobExternalId = String(15_000_000 + Math.floor(Math.random() * 100_000));
    const proposalId = await insertProposal(await insertJob(jobExternalId));
    const placer = freelancerBidPlacer({ db, config, now: () => NOW });
    const placed = await placer.placeBid(payload(proposalId, jobExternalId));
    const bid = fake.placedBids.find((b) => b.project_id === Number(jobExternalId))!;
    expect(placed).toEqual({ platformRef: String(bid.id) });
    expect(bid).toMatchObject({
      bidder_id: ME,
      amount: 4500,
      period: 7,
      milestone_percentage: 33,
      description: 'Thanks for the brief.',
    });
  });

  it('refuses, for good, a bid not in the project currency, and one with no account connected', async () => {
    const jobExternalId = String(15_100_000 + Math.floor(Math.random() * 100_000));
    const proposalId = await insertProposal(await insertJob(jobExternalId, 'USD'), 'ZAR');
    const placer = freelancerBidPlacer({ db, config, now: () => NOW });
    await expect(placer.placeBid(payload(proposalId, jobExternalId, 'ZAR'))).rejects.toThrow(
      /The bid is in ZAR but the project is in USD/,
    );
    await expect(placer.placeBid(payload(proposalId, jobExternalId, 'ZAR'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    await db.query(`update platform_accounts set status = 'disconnected' where id = $1`, [ACCOUNT]);
    try {
      const other = String(15_200_000 + Math.floor(Math.random() * 100_000));
      const id = await insertProposal(await insertJob(other));
      await expect(placer.placeBid(payload(id, other))).rejects.toThrow(
        /No Freelancer.com account is connected/,
      );
    } finally {
      await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
    }
  });
});

describe('a crash after the platform accepts the bid (E-05)', () => {
  it('does not send twice: the next attempt finds the bid and records it, counting it once', async () => {
    const jobExternalId = String(15_300_000 + Math.floor(Math.random() * 100_000));
    const proposalId = await insertProposal(await insertJob(jobExternalId));
    const placer = freelancerBidPlacer({ db, config, now: () => NOW });
    const planUse = async () =>
      (
        await db.query<{ used: number }>(
          `select coalesce(sum(used), 0)::int as used from usage_counters
            where org_id = $1 and metric = 'plan:bids_submitted'`,
          [ORG],
        )
      ).rows[0]?.used ?? 0;
    const allowanceUse = async () =>
      (
        await db.query<{ used: number }>(
          `select coalesce(sum(used), 0)::int as used from usage_counters
            where org_id = $1 and metric = 'bids:freelancer'`,
          [ORG],
        )
      ).rows[0]?.used ?? 0;
    const usedBefore = await planUse();
    const allowanceBefore = await allowanceUse();

    // The process dies the moment it goes to write down the platform's answer.
    let crashed = false;
    const crashing: Queryable = {
      query: async <T>(sql: string, params?: unknown[]) => {
        if (
          !crashed &&
          /insert into events/.test(sql) &&
          params?.[3] === 'external.call' &&
          params?.[7] === 'ok'
        ) {
          crashed = true;
          throw new Error('the process died');
        }
        return db.query<T>(sql, params);
      },
    };
    await expect(
      submitProposal({ db: crashing, liveMode: true, placer, now: () => NOW }, { proposalId }),
    ).rejects.toThrow('the process died');
    expect(fake.placedBids.filter((b) => b.project_id === Number(jobExternalId))).toHaveLength(1);

    // The queue tries again, on a process that lives.
    const result = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId },
    );
    const bids = fake.placedBids.filter((b) => b.project_id === Number(jobExternalId));
    expect(bids).toHaveLength(1);
    expect(result).toMatchObject({ status: 'submitted', platformRef: String(bids[0]!.id) });
    const posts = fake.calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.path === '/api/projects/0.1/bids/' &&
        (c.json as { project_id?: number } | undefined)?.project_id === Number(jobExternalId),
    );
    expect(posts).toHaveLength(1);
    const recorded = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from events where type = 'external.call' and subject_id = $1 and outcome = 'ok'`,
      [proposalId],
    );
    expect(recorded.rows).toHaveLength(1);
    expect(recorded.rows[0]?.payload).toMatchObject({
      platformRef: String(bids[0]!.id),
      reconciled: true,
    });
    // One bid, counted once against the plan and once against the bid allowance.
    expect((await planUse()) - usedBefore).toBe(1);
    expect((await allowanceUse()) - allowanceBefore).toBe(1);
  });
});

void randomUUID;
