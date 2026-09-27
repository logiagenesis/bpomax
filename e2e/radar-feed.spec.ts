import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * The radar's live feed (LI-PROMPT-BPOMAX-RADAR-20260927, 4.1) against recorded
 * Freelancer.com answers. The clock is set 5 minutes after the newest saved project.
 */
const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;
const HOURLY = ALL.filter((p) => p.type === 'hourly').length;

async function open(page: Page, options: Parameters<typeof serveFreelancer>[1] = {}) {
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, options);
  await page.goto('/radar.html');
  return calls;
}

const rows = (page: Page) => page.locator('#feed-list > li');

test('reads the newest projects from Freelancer.com and lists them', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('#status')).toHaveText(
    `Read ${String(ALL.length)} projects from Freelancer.com.`,
  );
  await expect(page.locator('#updated')).toHaveText(/^Last updated \d{2}:\d{2} SAST$/);
  await expect(page.locator('#updated')).toHaveText('Last updated 08:53 SAST');
  await expect(rows(page)).toHaveCount(ALL.length);
  await expect(page.locator('#feed-count')).toHaveText(
    `Showing ${String(ALL.length)} of the ${String(ALL.length)} projects read.`,
  );

  const query = calls.projects[0]!.searchParams;
  expect(query.get('limit')).toBe('100');
  expect(query.get('offset')).toBe('0');
  expect(query.get('full_description')).toBe('true');
  expect(query.get('job_details')).toBe('true');
  expect(query.get('sort_field')).toBe('time_submitted');
  expect(query.getAll('jobs[]')).toEqual([]);

  const first = ALL[0]!;
  const row = rows(page).filter({ hasText: first.title }).first();
  await expect(row.locator('.radar-row__skills')).toHaveText(
    first.jobs.map((j) => j.name).join(' · '),
  );
  await expect(row.locator('.radar-row__meta')).toContainText(
    `${String(first.bid_stats.bid_count)} bids`,
  );
  await expect(row.locator('.radar-row__meta')).toContainText(first.currency.code);
  const link = row.getByRole('link', { name: `Open ${first.title} on Freelancer.com` });
  await expect(link).toHaveAttribute(
    'href',
    `https://www.freelancer.com/projects/${first.seo_url}`,
  );
  await expect(link).toHaveAttribute('target', '_blank');
});

test('a row opens its full description, and Close shuts it', async ({ page }) => {
  await open(page);
  const project = ALL.find((p) => p.description.length > 200)!;
  await rows(page).filter({ hasText: project.title }).first().locator('.radar-row__meta').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(project.title);
  await expect(dialog.locator('#detail-description')).toHaveText(project.description);
  await expect(dialog.getByRole('link', { name: 'Open on Freelancer.com' })).toHaveAttribute(
    'href',
    `https://www.freelancer.com/projects/${project.seo_url}`,
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('Dismiss hides a project and remembers it; Restore brings it back', async ({ page }) => {
  await open(page);
  const project = ALL[1]!;
  await rows(page)
    .filter({ hasText: project.title })
    .first()
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect(page.locator('#status')).toHaveText(`Dismissed “${project.title}”.`);
  await expect(rows(page)).toHaveCount(ALL.length - 1);

  await page.reload();
  await expect(rows(page)).toHaveCount(ALL.length - 1);

  await page.locator('#filters-box > summary').click();
  await page.getByLabel('Hide projects already bid on or dismissed').uncheck();
  await expect(rows(page)).toHaveCount(ALL.length);
  const row = rows(page).filter({ hasText: project.title }).first();
  await expect(row.locator('.badge')).toContainText(['Dismissed']);
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#status')).toHaveText(`Restored “${project.title}”.`);
  await page.getByLabel('Hide projects already bid on or dismissed').check();
  await expect(rows(page)).toHaveCount(ALL.length);
});

test('filters narrow the feed and are saved', async ({ page }) => {
  await open(page);
  await page.locator('#filters-box > summary').click();
  await page.getByLabel('Type', { exact: true }).selectOption('hourly');
  await expect(rows(page)).toHaveCount(HOURLY);
  await page.getByLabel('Type', { exact: true }).selectOption('fixed');
  await expect(rows(page)).toHaveCount(ALL.length - HOURLY);
  await page.getByLabel('Type', { exact: true }).selectOption('both');

  const most = 5;
  await page.getByLabel('Most bids already placed').fill(String(most));
  await expect(rows(page)).toHaveCount(ALL.filter((p) => p.bid_stats.bid_count <= most).length);

  await page.getByLabel('Most bids already placed').fill('lots');
  await expect(page.locator('#filters-error')).toHaveText(
    'Enter a number of 0 or more in: Most bids already placed.',
  );
  await expect(page.getByLabel('Most bids already placed')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Most bids already placed').fill('');
  await expect(page.locator('#filters-error')).toBeHidden();

  const word = ALL[2]!.title.split(' ')[0]!;
  await page.getByLabel('Leave out titles with').fill(`${word.toUpperCase()}, zzzz`);
  const left = ALL.filter((p) => !p.title.toLowerCase().includes(word.toLowerCase())).length;
  await expect(rows(page)).toHaveCount(left);

  await page.getByLabel('Oldest, in hours').fill('0,5');
  await page.getByLabel('Minimum budget, fixed (USD)').fill('100');
  await page.getByLabel('Minimum rate, hourly (USD)').fill('15');
  const expected = ALL.filter((p) => {
    if (p.title.toLowerCase().includes(word.toLowerCase())) return false;
    if (NOW - p.time_submitted * 1000 > 30 * 60_000) return false;
    const top = (p.budget.maximum ?? p.budget.minimum ?? 0) * p.currency.exchange_rate;
    return p.type === 'fixed' ? top >= 100 : top >= 15;
  }).length;
  await expect(rows(page)).toHaveCount(expected);

  await page.reload();
  await page.locator('#filters-box > summary').click();
  await expect(page.getByLabel('Oldest, in hours')).toHaveValue('0,5');
  await expect(page.getByLabel('Leave out titles with')).toHaveValue(`${word.toUpperCase()}, zzzz`);
  await expect(rows(page)).toHaveCount(expected);
});

test('picking skills to watch reads their projects; removing one reads again', async ({ page }) => {
  const calls = await open(page);
  await expect(rows(page)).toHaveCount(ALL.length);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Find a skill').first().fill('php');
  await page.getByRole('checkbox', { name: 'PHP', exact: true }).check();
  await expect(page.locator('#watch-chosen')).toHaveText(/PHP/);
  await expect.poll(() => calls.projects.length, { timeout: 5000 }).toBe(2);
  expect(calls.projects[1]!.searchParams.getAll('jobs[]')).toEqual(['3']);
  expect(calls.skills).toBe(1);

  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#watch-chosen')).toHaveText(/PHP/);
  expect(calls.projects[2]!.searchParams.getAll('jobs[]')).toEqual(['3']);
  await page.getByRole('button', { name: 'Remove PHP' }).click();
  await expect(page.locator('#watch-chosen')).toBeEmpty();
  await expect.poll(() => calls.projects.length, { timeout: 5000 }).toBe(4);
  expect(calls.projects[3]!.searchParams.getAll('jobs[]')).toEqual([]);
  // The skills list came from this browser's copy the second time.
  await page.getByLabel('Find a skill').first().fill('wordp');
  await expect(page.getByRole('checkbox', { name: 'WordPress', exact: true })).toBeVisible();
  expect(calls.skills).toBe(1);
});

test('reads again every 2 minutes, or only on Refresh now when set to manual', async ({ page }) => {
  const calls = await open(page);
  await expect(rows(page)).toHaveCount(ALL.length);
  expect(calls.projects).toHaveLength(1);
  await page.clock.runFor(2 * 60_000);
  await expect.poll(() => calls.projects.length).toBe(2);

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Read the feed again').selectOption('0');
  await expect(page.locator('#status')).toHaveText(
    'The feed is read only when you press Refresh now.',
  );
  await page.clock.runFor(15 * 60_000);
  expect(calls.projects).toHaveLength(2);
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect.poll(() => calls.projects.length).toBe(3);
  await expect(page.locator('#status')).toHaveText(
    `Read ${String(ALL.length)} projects from Freelancer.com.`,
  );

  await page.getByLabel('Read the feed again').selectOption('5');
  await expect(page.locator('#status')).toHaveText('The feed is read every 5 minutes.');
  await page.clock.runFor(4 * 60_000);
  expect(calls.projects).toHaveLength(3);
  await page.clock.runFor(60_000);
  await expect.poll(() => calls.projects.length).toBe(4);
});

test('an error from Freelancer.com shows, and the next try backs off', async ({ page }) => {
  const calls = await open(page, { projects: 429 });
  await expect(page.locator('#status')).toHaveText(
    'Freelancer.com answered HTTP 429: Rate limit exceeded. Trying again at 08:57 SAST.',
  );
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
  await page.clock.runFor(3 * 60_000);
  expect(calls.projects).toHaveLength(1);
  await page.clock.runFor(60_000);
  await expect.poll(() => calls.projects.length).toBe(2);
  await expect(page.locator('#status')).toHaveText(
    'Freelancer.com answered HTTP 429: Rate limit exceeded. Trying again at 09:05 SAST.',
  );
});

test('the page allows calls to Freelancer.com and nothing else new', async ({ page }) => {
  await open(page);
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(policy).toContain("connect-src 'self' https://www.freelancer.com;");
});

test('works at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expect(rows(page)).toHaveCount(ALL.length);
  await expectNoSidewaysScroll(page);
  await page.locator('#filters-box > summary').click();
  await expectNoSidewaysScroll(page);
  await rows(page).first().locator('.radar-row__meta').click();
  await expectNoSidewaysScroll(page);
});
