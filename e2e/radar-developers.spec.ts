import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { DIRECTORY, NEWEST, serveFreelancer } from './radar-helpers.js';

/**
 * The developer finder (LI-PROMPT-BPOMAX-RADAR-20260927, 4.6), against a real answer from
 * Freelancer.com's directory (query "wordpress", saved 27/09/2026 and trimmed).
 */
const NOW = NEWEST + 5 * 60_000;
const USERS = DIRECTORY.result.users;

/** What the page should show with filters `completion` % and `reviews`, in order. */
function expected(completion: number, reviews: number) {
  return USERS.filter(
    (u) =>
      u.reputation.entire_history.completion_rate * 100 >= completion &&
      u.reputation.entire_history.reviews >= reviews,
  )
    .sort(
      (a, b) =>
        b.reputation.entire_history.overall - a.reputation.entire_history.overall ||
        b.reputation.entire_history.reviews - a.reputation.entire_history.reviews,
    )
    .map((u) => u.username);
}

async function open(page: Page, options: Parameters<typeof serveFreelancer>[1] = {}) {
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, options);
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  await page.getByRole('tab', { name: 'Developers' }).click();
  return calls;
}

async function search(page: Page, text = 'wordpress') {
  await page.getByLabel('Search Freelancer.com’s freelancers').fill(text);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

const results = (page: Page) => page.locator('#dev-results > li');

test('searches the directory and shows the developers who meet the filters, best first', async ({
  page,
}) => {
  const calls = await open(page);
  await expect(page.locator('#dev-filters')).toHaveText(
    'Shows freelancers with at least 90 % of jobs completed and at least 20 reviews, best rated first. Change this in Settings.',
  );
  await search(page);
  const names = expected(90, 20);
  await expect(page.locator('#status')).toHaveText(
    `Found ${String(USERS.length)} freelancers for “wordpress”; ${String(names.length)} meet your filters.`,
  );
  await expect(results(page).locator('h3')).toHaveText(names);
  expect(Object.fromEntries(calls.directory[0]!.searchParams)).toEqual({
    query: 'wordpress',
    limit: '50',
    reputation: 'true',
    country_details: 'true',
  });

  const top = USERS.find((u) => u.username === names[0])!;
  const h = top.reputation.entire_history;
  const first = results(page).first();
  await expect(first.locator('.radar-row__meta')).toHaveText(
    [
      top.location.country.name,
      `USD ${String(top.hourly_rate)} an hour`,
      `${String(h.all)} jobs`,
      `${String(h.reviews)} reviews`,
      `rated ${h.overall.toFixed(2).replace('.', ',')} of 5`,
      `${(h.completion_rate * 100).toFixed(1).replace('.', ',')}% completed`,
    ].join(' · '),
  );
  const link = first.getByRole('link', { name: top.username });
  await expect(link).toHaveAttribute('href', `https://www.freelancer.com/u/${top.username}`);
  await expect(link).toHaveAttribute('target', '_blank');
});

test('the filters are the owner’s settings', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Lowest completion rate, %').fill('99');
  await page.getByLabel('Fewest reviews').fill('500');
  await page.getByRole('tab', { name: 'Developers' }).click();
  await search(page);
  await expect(results(page).locator('h3')).toHaveText(expected(99, 500));
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Fewest reviews').fill('lots');
  await expect(page.locator('#settings-error')).toHaveText(
    'Fewest reviews: a whole number from 0 to 100000.',
  );
});

test('an empty search, or an error from Freelancer.com, says so', async ({ page }) => {
  await open(page, { directory: 503 });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#status')).toHaveText(
    'Type what to search for, for example wordpress.',
  );
  await search(page);
  await expect(page.locator('#status')).toHaveText(
    'Freelancer.com answered HTTP 503: Service unavailable.',
  );
  await expect(results(page)).toHaveCount(0);
});

test('the shortlist keeps developers with the owner’s rate and note', async ({ page }) => {
  await open(page);
  await expect(page.locator('#shortlist-empty')).toBeVisible();
  await search(page);
  const name = expected(90, 20)[0]!;
  const user = USERS.find((u) => u.username === name)!;
  await page.getByRole('button', { name: `Shortlist ${name}` }).click();
  await expect(page.locator('#status')).toHaveText(`Shortlisted ${name}.`);
  await expect(page.getByRole('button', { name: `${name} is shortlisted` })).toBeDisabled();
  const listed = page.locator('#shortlist > li');
  await expect(listed).toHaveCount(1);
  await expect(listed.getByLabel('Your price or rate for them (USD)')).toHaveValue(
    String(user.hourly_rate),
  );
  await listed.getByLabel('Your price or rate for them (USD)').fill('120');
  await listed.getByLabel('Note').fill('Good WordPress work');

  await page.reload();
  await page.getByRole('tab', { name: 'Developers' }).click();
  await expect(listed.getByLabel('Your price or rate for them (USD)')).toHaveValue('120');
  await expect(listed.getByLabel('Note')).toHaveValue('Good WordPress work');

  await page.getByRole('button', { name: `Remove ${name} from the shortlist` }).click();
  await expect(listed).toHaveCount(0);
  await expect(page.locator('#shortlist-empty')).toBeVisible();
});

test('an awarded bid takes its delivery cost from a shortlisted developer', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'radar.shortlist',
      JSON.stringify([
        {
          username: 'devone',
          profile: 'https://www.freelancer.com/u/devone',
          country: 'India',
          hourlyRateUsd: 20,
          rating: 4.9,
          reviews: 100,
          rateUsd: 180,
          note: '',
        },
      ]),
    );
    localStorage.setItem(
      'radar.log',
      JSON.stringify([
        {
          id: 'bid-1',
          projectId: 1,
          title: 'Logged project',
          url: 'https://www.freelancer.com/projects/x/1',
          skills: [],
          budget: { min: 250, max: 750 },
          type: 'fixed',
          currency: 'USD',
          usdRate: 1,
          price: 450,
          days: 7,
          templateId: null,
          templateName: null,
          proposal: '',
          score: 60,
          scoreParts: { skill: 0, budget: 0, fresh: 0, competition: 0 },
          bidCount: 1,
          ageMinutes: 5,
          placedAt: '2026-09-20T08:00:00.000Z',
          status: 'awarded',
          replied: true,
          award: { agreedPrice: 450, deliveryCostUsd: 0, developer: null, note: '' },
        },
      ]),
    );
  });
  await open(page);
  await page.getByRole('tab', { name: 'Bids' }).click();
  const bid = page.locator('#bid-list > li');
  await expect(bid.getByLabel('Delivered by')).toHaveValue('');
  await bid.getByLabel('Delivered by').selectOption('devone');
  await expect(bid.getByLabel('Delivery cost (USD)')).toHaveValue('180');
  await expect(bid.locator('.field__hint').last()).toHaveText(
    'Awarded USD 450,00. Margin USD 270,00 (fee not set).',
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Bids' }).click();
  await expect(bid.getByLabel('Delivered by')).toHaveValue('devone');
  await expect(bid.getByLabel('Delivery cost (USD)')).toHaveValue('180');
  await bid.getByLabel('Delivered by').selectOption('');
  await expect(bid.getByLabel('Delivery cost (USD)')).toHaveValue('0');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.log') ?? '[]'));
  expect(saved[0].award).toEqual({
    agreedPrice: 450,
    deliveryCostUsd: 0,
    developer: null,
    note: '',
  });
});

test('the Developers tab works at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await search(page);
  await page.getByRole('button', { name: `Shortlist ${expected(90, 20)[0]!}` }).click();
  await expectNoSidewaysScroll(page);
});
