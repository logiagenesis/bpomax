import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freelancerConfig, type FreelancerConfig } from './config.js';
import {
  createProject,
  findCurrencyId,
  findJobIds,
  listProjectBids,
  parseBid,
} from './employer.js';
import { startFakeFreelancer, type FakeFreelancer } from './fake.js';
import { FreelancerError } from './http.js';
import { exchangeCode } from './oauth.js';

/**
 * ARB-203: the employer's calls, held to the documented requests
 * (developers.freelancer.com, "Creating a Project" and "List Project Bids") and run
 * against the stand-in over HTTP.
 */
const REDIRECT = 'https://app.example.test/freelancer-callback.html';
let fake: FakeFreelancer;
let config: FreelancerConfig;
let accessToken: string;

beforeAll(async () => {
  fake = await startFakeFreelancer();
  fake.setCurrencies([
    { id: 1, code: 'USD' },
    { id: 3, code: 'AUD' },
    { id: 30, code: 'ZAR' },
  ]);
  fake.setJobs([
    { id: 3, name: 'PHP' },
    { id: 235, name: 'CakePHP' },
    { id: 17, name: 'Website Design' },
    { id: 1001, name: 'Shopify' },
  ]);
  fake.setBidders([
    { id: 501, username: 'thandi-web', country_code: 'za' },
    { id: 502, username: 'nord-studio' },
  ]);
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

describe('the lookups', () => {
  it('finds a currency’s id by its code, and null for one the platform does not list', async () => {
    expect(await findCurrencyId(config, accessToken, 'zar')).toBe(30);
    expect(await findCurrencyId(config, accessToken, 'XYZ')).toBeNull();
    const call = fake.calls.find((c) => c.path === '/api/projects/0.1/currencies/');
    expect(call?.queryAll['currency_codes[]']).toEqual(['ZAR']);
    expect(call?.headers['freelancer-oauth-v1']).toBe(accessToken);
  });

  it('takes only skills whose name is exactly the one asked for, not every name containing it', async () => {
    expect(await findJobIds(config, accessToken, ['php'])).toEqual([3]);
    expect(await findJobIds(config, accessToken, ['Shopify', 'Website design'])).toEqual([
      17, 1001,
    ]);
    expect(await findJobIds(config, accessToken, ['Plumbing'])).toEqual([]);
  });
});

describe('creating a project', () => {
  it('sends the documented JSON body and reads the id and the title as created', async () => {
    const created = await createProject(config, accessToken, {
      title: 'Shopify: An online shop',
      description: 'Scope only.',
      currencyId: 30,
      budget: { minimum: 8000, maximum: 12000 },
      jobIds: [1001],
    });
    expect(created).toMatchObject({ id: '16000001', title: 'Shopify: An online shop' });
    const call = fake.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/projects/0.1/projects/',
    );
    expect(call?.json).toEqual({
      title: 'Shopify: An online shop',
      description: 'Scope only.',
      currency: { id: 30 },
      budget: { minimum: 8000, maximum: 12000 },
      jobs: [{ id: 1001 }],
    });
    expect(call?.headers['content-type']).toBe('application/json');
    // "Multiple projects with the same name are not allowed": the title comes back numbered.
    const second = await createProject(config, accessToken, {
      title: 'Shopify: An online shop',
      description: 'Scope only.',
      currencyId: 30,
      budget: { minimum: 8000, maximum: 12000 },
      jobIds: [1001],
    });
    expect(second.title).toBe('Shopify: An online shop -- 2');
  });

  it('a refused project is a FreelancerError with the status, and a bad token a 401', async () => {
    await expect(
      createProject(config, accessToken, {
        title: 'No skills',
        description: 'x',
        currencyId: 30,
        budget: { minimum: 1, maximum: 2 },
        jobIds: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const refused = await createProject(config, 'not-a-token', {
      title: 'T',
      description: 'x',
      currencyId: 30,
      budget: { minimum: 1, maximum: 2 },
      jobIds: [1],
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FreelancerError);
    expect((refused as FreelancerError).isAuthFailure).toBe(true);
  });
});

describe('the project’s bids', () => {
  it('reads each bid with the bidder’s name and country, asking for both projections', async () => {
    fake.setBids(16000001, [
      { id: 901, bidder_id: 501, amount: 9000.5, period: 5, submitdate: 1790150400 },
      { id: 902, bidder_id: 502, amount: 11000, period: 30 },
    ]);
    const page = await listProjectBids(config, accessToken, '16000001');
    expect(page.bids).toEqual([
      {
        id: '901',
        bidderId: '501',
        projectId: '16000001',
        amount: 9000.5,
        period: 5,
        submittedAt: new Date(1790150400 * 1000),
        description: null,
        bidderUsername: 'thandi-web',
        bidderCountryCode: 'ZA',
      },
      expect.objectContaining({
        id: '902',
        bidderUsername: 'nord-studio',
        bidderCountryCode: null,
      }),
    ]);
    const call = fake.calls.find((c) => c.path === '/api/projects/0.1/projects/16000001/bids/');
    expect(call?.query).toMatchObject({
      user_details: 'true',
      user_country_details: 'true',
      limit: '100',
      offset: '0',
    });
  });

  it('skips a bid without an id, a bidder or an amount rather than guess', () => {
    expect(parseBid({ bidder_id: 1, amount: 5 }, {})).toBeNull();
    expect(parseBid({ id: 1, amount: 5 }, {})).toBeNull();
    expect(parseBid({ id: 1, bidder_id: 2 }, {})).toBeNull();
  });
});
