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
const DIRECTORY = fixture('directory.json');

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
}

/**
 * Answers the three Freelancer.com calls the page makes. `projects` may replace the
 * search's answer (a status to fail with, or other projects).
 */
export async function serveFreelancer(
  page: Page,
  options: { projects?: RawProject[] | number } = {},
): Promise<FreelancerCalls> {
  const calls: FreelancerCalls = { projects: [], skills: 0, directory: [] };
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
        json: { status: 'success', result: { projects: offset ? [] : answer, users: {} } },
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
      await route.fulfill({ json: DIRECTORY, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'error', message: 'not in the e2e' } });
  });
  return calls;
}
