import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freelancerConfig, type FreelancerConfig } from './config.js';
import {
  FAKE_RATE_LIMIT,
  startFakeFreelancer,
  type FakeFreelancer,
  type FakeProject,
} from './fake.js';
import { FreelancerError } from './http.js';
import { exchangeCode } from './oauth.js';
import { activeProjectsSearchParams, parseProject, searchActiveProjects } from './projects.js';

/**
 * ARB-022: the project search, held to the documented request and the documented
 * answer (developers.freelancer.com, "Search for Active Projects" and the "Bidding on a
 * Project" walkthrough), against the stand-in over HTTP.
 */
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';

/** The first project of the docs' worked example, as printed there. */
const DOCUMENTED_PROJECT = {
  hidebids: false,
  bidperiod: 7,
  currency: { code: 'USD', name: 'US Dollar', country: 'US', sign: '$', exchange_rate: 1, id: 1 },
  featured: false,
  preview_description:
    'An error on server side is preventing notifications to work in our iOS app. Can you fix it?\nWhen a',
  id: 15791512,
  negotiated: false,
  title: 'Fix a notifications bug - Python/Django Rest Framework',
  submitdate: 1512366214,
  nonpublic: false,
  location: { country: {} },
  type: 'fixed',
  hireme: false,
  status: 'active',
  frontend_project_status: 'open',
  deleted: false,
  time_free_bids_expire: 1512362609,
  time_updated: 1512362614,
  language: 'en',
  seo_url: 'python/Fix-notifications-bug-Python-Django',
  urgent: false,
  local: false,
  time_submitted: 1512366214,
  budget: { minimum: 250, maximum: 750 },
  bid_stats: { bid_count: 33, bid_avg: 462.57575757575756 },
};

const PROJECTS: FakeProject[] = [
  {
    id: 15791512,
    title: 'Fix a notifications bug - Python/Django Rest Framework',
    preview_description: 'An error on server side is preventing notifications to work',
    description: 'An error on server side is preventing notifications to work in our iOS app.',
    type: 'fixed',
    budget: { minimum: 250, maximum: 750 },
    currency: { code: 'USD', id: 1 },
    jobs: [
      { id: 13, name: 'Python', seo_url: 'python' },
      { id: 669, name: 'Django', seo_url: 'django' },
    ],
    bid_stats: { bid_count: 33, bid_avg: 462.57575757575756 },
    time_submitted: 1512366214,
    time_updated: 1512362614,
    status: 'active',
    seo_url: 'python/Fix-notifications-bug-Python-Django',
    location: { country: { code: 'US' } },
  },
  {
    id: 15822385,
    title: 'Website Developer',
    preview_description: 'The primary focus of the Website Developer is to ensure',
    type: 'hourly',
    budget: { minimum: 50 },
    currency: { code: 'USD', id: 1 },
    jobs: [{ id: 3, name: 'PHP', seo_url: 'php' }],
    bid_stats: { bid_count: 74, bid_avg: 54.108108108108105 },
    time_submitted: 1512665861,
    time_updated: 1512662261,
    status: 'active',
    seo_url: 'graphic-design/Website-Developer-15822385',
  },
];

let fake: FakeFreelancer;
let config: FreelancerConfig;
let accessToken: string;

beforeAll(async () => {
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
  accessToken = (await exchangeCode(config, fake.issueCode(REDIRECT))).accessToken;
});

afterAll(async () => {
  await fake.close();
});

describe('the request', () => {
  it('is the documented query string: arrays once per value, projections present, limit capped at 100', () => {
    const params = activeProjectsSearchParams({
      query: ' django rest ',
      projectTypes: ['fixed'],
      countries: ['ZA', 'us'],
      minPriceUsd: '250.00',
      limit: 500,
      offset: 3,
    });
    expect(params.toString()).toBe(
      'query=django+rest&project_types%5B%5D=fixed&countries%5B%5D=za&countries%5B%5D=us' +
        '&min_price=250.00&sort_field=time_updated&limit=100&offset=3' +
        '&full_description=true&job_details=true',
    );
  });

  it('with no filter asks for the newest 100, still with both projections', () => {
    expect(activeProjectsSearchParams({}).toString()).toBe(
      'sort_field=time_updated&limit=100&full_description=true&job_details=true',
    );
  });
});

describe('the documented answer', () => {
  it('is read field by field, with times as seconds', () => {
    const project = parseProject(DOCUMENTED_PROJECT);
    expect(project).toMatchObject({
      id: '15791512',
      title: 'Fix a notifications bug - Python/Django Rest Framework',
      type: 'fixed',
      budgetMinimum: 250,
      budgetMaximum: 750,
      currencyCode: 'USD',
      skills: [],
      bidCount: 33,
      bidAverage: 462.57575757575756,
      status: 'active',
      seoUrl: 'python/Fix-notifications-bug-Python-Django',
    });
    expect(project?.description).toMatch(/^An error on server side/);
    expect(project?.submittedAt?.toISOString()).toBe('2017-12-04T05:43:34.000Z');
    expect(project?.updatedAt?.toISOString()).toBe('2017-12-04T04:43:34.000Z');
    expect(project?.raw).toBe(DOCUMENTED_PROJECT);
  });

  it('a project without an id or a title is left out rather than guessed at', () => {
    expect(parseProject({ title: 'no id' })).toBeNull();
    expect(parseProject({ id: 1 })).toBeNull();
  });
});

describe('against the stand-in', () => {
  it('sends the token in the documented header and gets the page, the count and the rate-limit headers', async () => {
    const page = await searchActiveProjects(config, accessToken, { query: 'django' });
    const call = fake.calls.filter((c) => c.path === '/api/projects/0.1/projects/active/').at(-1)!;
    expect(call.headers['freelancer-oauth-v1']).toBe(accessToken);
    expect(call.query).toMatchObject({ query: 'django', sort_field: 'time_updated', limit: '100' });
    expect(page.totalCount).toBe(1);
    expect(page.projects).toHaveLength(1);
    expect(page.projects[0]).toMatchObject({
      id: '15791512',
      description: 'An error on server side is preventing notifications to work in our iOS app.',
      skills: ['Python', 'Django'],
    });
    expect(page.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(page.rateLimit).toEqual({ limit: FAKE_RATE_LIMIT, remaining: 45 });
  });

  it('filters by type and price as the docs describe', async () => {
    const hourly = await searchActiveProjects(config, accessToken, { projectTypes: ['hourly'] });
    expect(hourly.projects.map((p) => p.id)).toEqual(['15822385']);
    const pricey = await searchActiveProjects(config, accessToken, { minPriceUsd: '100.00' });
    expect(pricey.projects.map((p) => p.id)).toEqual(['15791512']);
  });

  it('a used-up window is a 429 with the documented code and no requests remaining', async () => {
    fake.rateLimitNextCalls(1);
    const error = await searchActiveProjects(config, accessToken, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    const refused = error as FreelancerError;
    expect(refused.status).toBe(429);
    expect(refused.isRateLimited).toBe(true);
    expect(refused.errorCode).toBe('AuthorisationExceptionCodes.RATE_LIMITED');
    expect(refused.rateLimit).toEqual({ limit: FAKE_RATE_LIMIT, remaining: 0 });
    // The window has passed: the same call works.
    expect((await searchActiveProjects(config, accessToken, {})).projects).toHaveLength(2);
  });

  it('a bad token is a 401 that asking again will not fix', async () => {
    const error = await searchActiveProjects(config, 'access-nope', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    expect((error as FreelancerError).status).toBe(401);
    expect((error as FreelancerError).isAuthFailure).toBe(true);
  });
});
