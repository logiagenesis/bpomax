import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * The radar page reads Freelancer.com's public API from the browser. In these specs every
 * call to it is answered here from real responses saved on 27/09/2026 and trimmed
 * (e2e/fixtures/radar: the project search F1, the skills list F3, the directory F6), so no
 * run depends on Freelancer.com being up.
 */
const FREELANCER_API = 'https://www.freelancer.com/api';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/radar/${name}`, import.meta.url), 'utf8'));

export const PROJECTS = fixture('projects.json') as {
  result: { projects: RawProject[] };
};
const JOBS = fixture('jobs.json');
export const DIRECTORY = fixture('directory.json') as {
  result: { users: RawUser[] };
};

interface RawUser {
  username: string;
  hourly_rate: number;
  location: { country: { name: string } };
  reputation: {
    entire_history: { all: number; reviews: number; overall: number; completion_rate: number };
  };
}

interface RawProject {
  id: number;
  title: string;
  seo_url: string;
  type: 'fixed' | 'hourly';
  description: string;
  time_submitted: number;
  currency: { code: string; exchange_rate: number };
  budget: { minimum: number | null; maximum: number | null };
  bid_stats: { bid_count: number; bid_avg: number | null };
  jobs: { id: number; name: string }[];
  upgrades: Record<string, boolean>;
}

/** The newest project in the saved search was posted at 06:48:14 UTC on 27/09/2026. */
export const NEWEST = Math.max(...PROJECTS.result.projects.map((p) => p.time_submitted)) * 1000;

interface FreelancerCalls {
  projects: URL[];
  skills: number;
  directory: URL[];
  /** The token each call to GET /users/0.1/self/ carried. */
  self: (string | undefined)[];
  /** Each look for an earlier bid (GET /projects/0.1/bids/), with its token. */
  bidLookups: { url: URL; token: string | undefined }[];
  /** Each bid sent (POST /projects/0.1/bids/): its JSON body and token. */
  bidsSent: { body: Record<string, unknown>; token: string | undefined }[];
}

interface BidOptions {
  /** A bid of the bidder's already on Freelancer.com, as the bid list gives it. */
  existing?: { id: number; bidder_id: number; project_id: number; amount: number };
  /** Refuse the POST with this status. */
  refuse?: number;
  /** Never answer the POST: it is received, recorded, and left hanging. */
  hang?: boolean;
}

/**
 * GET /users/0.1/self/ as it answered on 28/09/2026 (the fields checked then: id,
 * username, role, limited_account, membership_package), with a made-up user.
 */
const SELF = {
  status: 'success',
  result: {
    id: 1234567,
    username: 'example-user',
    role: 'freelancer',
    limited_account: false,
    membership_package: { name: 'plus', bid_limit: 100, duration_type: 'month' },
  },
};

/**
 * Answers the three Freelancer.com calls the page makes. `projects` may replace the
 * search's answer (a status to fail with, or other projects).
 */
export async function serveFreelancer(
  page: Page,
  options: {
    projects?: RawProject[] | number;
    directory?: number;
    self?: number;
    /** Never answer GET /users/0.1/self/: it is received, recorded, and left hanging. */
    selfHang?: boolean;
    bids?: BidOptions;
  } = {},
): Promise<FreelancerCalls> {
  const calls: FreelancerCalls = {
    projects: [],
    skills: 0,
    directory: [],
    self: [],
    bidLookups: [],
    bidsSent: [],
  };
  let nextBidId = 900_000_001;
  // Pages the radar opens in a new tab (a project, a freelancer's profile) land here.
  await page.context().route('https://www.freelancer.com/{projects,u}/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Freelancer.com</title>',
    }),
  );
  await page.route(`${FREELANCER_API}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/projects/0.1/projects/active/') {
      calls.projects.push(url);
      const answer = options.projects ?? PROJECTS.result.projects;
      if (typeof answer === 'number') {
        await route.fulfill({
          status: answer,
          json: { status: 'error', message: 'Rate limit exceeded', error_code: 'rate_limit' },
          headers: { 'access-control-allow-origin': '*' },
        });
        return;
      }
      const offset = Number(url.searchParams.get('offset') ?? '0');
      await route.fulfill({
        json: {
          status: 'success',
          result: { projects: offset ? [] : answer, users: {}, total_count: answer.length },
        },
        headers: { 'access-control-allow-origin': '*' },
      });
      return;
    }
    if (url.pathname === '/api/projects/0.1/jobs/') {
      calls.skills += 1;
      await route.fulfill({ json: JOBS, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    if (url.pathname === '/api/users/0.1/users/directory/') {
      calls.directory.push(url);
      if (options.directory) {
        await route.fulfill({
          status: options.directory,
          json: { status: 'error', message: 'Service unavailable' },
          headers: { 'access-control-allow-origin': '*' },
        });
        return;
      }
      await route.fulfill({ json: DIRECTORY, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    if (url.pathname === '/api/users/0.1/self/') {
      calls.self.push(route.request().headers()['freelancer-oauth-v1']);
      if (options.selfHang) return;
      if (options.self) {
        // How Freelancer.com refuses a token it does not accept (checked 28/09/2026).
        await route.fulfill({
          status: options.self,
          json: {
            status: 'error',
            message: 'You must be logged in to perform this request',
            error_code: 'RestExceptionCodes.NOT_AUTHENTICATED',
          },
          headers: { 'access-control-allow-origin': '*' },
        });
        return;
      }
      await route.fulfill({ json: SELF, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    if (url.pathname === '/api/projects/0.1/bids/') {
      const request = route.request();
      const token = request.headers()['freelancer-oauth-v1'];
      const cors = { 'access-control-allow-origin': '*' };
      if (request.method() === 'GET') {
        calls.bidLookups.push({ url, token });
        const existing = options.bids?.existing;
        await route.fulfill({
          json: { status: 'success', result: { bids: existing ? [existing] : [], users: {} } },
          headers: cors,
        });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.bidsSent.push({ body, token });
      if (options.bids?.hang) return;
      if (options.bids?.refuse) {
        await route.fulfill({
          status: options.bids.refuse,
          json: {
            status: 'error',
            message: 'Refused in the e2e',
            error_code: 'E2E',
          },
          headers: cors,
        });
        return;
      }
      await route.fulfill({
        json: { status: 'success', result: { id: nextBidId++, ...body } },
        headers: cors,
      });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'error', message: 'not in the e2e' } });
  });
  return calls;
}
