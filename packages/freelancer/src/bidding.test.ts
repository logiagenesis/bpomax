import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBid, findBid } from './bidding.js';
import { freelancerConfig, type FreelancerConfig } from './config.js';
import { startFakeFreelancer, type FakeFreelancer } from './fake.js';
import { FreelancerError } from './http.js';
import { exchangeCode } from './oauth.js';

/**
 * ARB-511: the bid calls, held to the documented request
 * (developers.freelancer.com, "Bidding on a Project", "Creating a Bid"; "Bids", "List
 * Bids") and run against the stand-in over HTTP.
 */
const REDIRECT = 'https://app.example.test/freelancer-callback.html';
const ME = 1_000_001;
let fake: FakeFreelancer;
let config: FreelancerConfig;
let accessToken: string;

beforeAll(async () => {
  fake = await startFakeFreelancer();
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
  accessToken = (await exchangeCode(config, fake.issueCode(REDIRECT))).accessToken;
});

afterAll(async () => {
  await fake.close();
});

describe('createBid', () => {
  it('posts the five required fields and the description, with the token, and answers the bid id', async () => {
    const placed = await createBid(config, accessToken, {
      projectId: 15339400,
      bidderId: ME,
      amount: 60,
      period: 7,
      milestonePercentage: 100,
      description: 'I can start on Monday.',
    });
    expect(placed.id).toBe(String(fake.placedBids[0]!.id));
    const call = fake.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/projects/0.1/bids/',
    );
    expect(call?.headers['freelancer-oauth-v1']).toBe(accessToken);
    expect(call?.headers['content-type']).toBe('application/json');
    // The documented example body, field for field.
    expect(call?.json).toEqual({
      project_id: 15339400,
      bidder_id: ME,
      amount: 60,
      period: 7,
      milestone_percentage: 100,
      description: 'I can start on Monday.',
    });
  });

  it('says what the platform refused, and never sends twice on its own', async () => {
    const before = fake.placedBids.length;
    await expect(
      createBid(config, accessToken, {
        projectId: 15339400,
        bidderId: 999, // not this account: the stand-in refuses, as the platform would
        amount: 60,
        period: 7,
        milestonePercentage: 100,
        description: '',
      }),
    ).rejects.toBeInstanceOf(FreelancerError);
    expect(fake.placedBids.length).toBe(before);
  });
});

describe('findBid', () => {
  it("finds this bidder's bid on the project by the documented filters, and nothing on another", async () => {
    const found = await findBid(config, accessToken, { projectId: 15339400, bidderId: ME });
    expect(found).toMatchObject({ id: String(fake.placedBids[0]!.id), amount: 60, period: 7 });
    const call = [...fake.calls]
      .reverse()
      .find((c) => c.method === 'GET' && c.path === '/api/projects/0.1/bids/');
    expect(call?.queryAll).toEqual({ 'projects[]': ['15339400'], 'bidders[]': [String(ME)] });
    expect(await findBid(config, accessToken, { projectId: 1, bidderId: ME })).toBeNull();
  });
});
