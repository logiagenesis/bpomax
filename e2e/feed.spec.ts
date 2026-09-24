import { expect, test, type Page } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Captured,
  type Role,
} from './helpers.js';

/** Rows as GET /v1/jobs returns them (apps/api/src/routes/jobs.ts). */
function job(partial: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    platform: 'freelancer',
    external_id: 'x',
    title: 'A job',
    currency: 'ZAR',
    budget_min_minor: '100000',
    budget_max_minor: '200000',
    hourly: false,
    client_country: 'ZA',
    client_payment_verified: true,
    bid_count: 4,
    posted_at: '2026-09-22T08:00:00Z',
    first_seen_at: '2026-09-22T08:05:00Z',
    category_slug: 'wordpress',
    score: null,
    verdict: null,
    flags: null,
    estimate_expected_minor: null,
    estimate_currency: null,
    estimate_method: null,
    margin_id: null,
    margin_minor: null,
    margin_pct: null,
    margin_currency: null,
    margin_passed: null,
    margin_reason: null,
    proposal_id: null,
    proposal_status: null,
    ...partial,
  };
}

const READY = job({
  title: 'Shopify store rebuild',
  score: 82,
  verdict: 'go',
  estimate_expected_minor: '150000',
  estimate_currency: 'ZAR',
  estimate_method: 'rate_card',
  margin_id: 'm1',
  margin_minor: '75000',
  margin_pct: '37.500',
  margin_currency: 'ZAR',
  margin_passed: true,
});
const QUEUED = job({
  title: 'Landing page, urgent',
  score: 61,
  verdict: 'caution',
  flags: ['unverified_payment'],
  proposal_id: 'p1',
  proposal_status: 'queued',
  currency: 'USD',
  budget_min_minor: '50000',
  budget_max_minor: '50000',
  hourly: true,
});
const SKIP = job({
  title: 'Pay us first',
  score: 5,
  verdict: 'skip',
  flags: ['upfront_fee'],
  client_payment_verified: false,
});
const FRESH = job({
  title: 'Untouched job',
  currency: null,
  budget_min_minor: null,
  budget_max_minor: null,
  bid_count: null,
});
const ALL = [READY, QUEUED, SKIP, FRESH];

interface Options {
  role?: Role;
  queueBid?: { status: number; json: unknown };
  jobs?: ReturnType<typeof job>[];
}

async function open(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  const requests = await serveApi(
    page,
    {
      'GET /v1/jobs': (request, route) => {
        const verdict = request.query.get('verdict');
        const limit = Number(request.query.get('limit') ?? 25);
        const offset = Number(request.query.get('offset') ?? 0);
        const rows = (options.jobs ?? ALL)
          .filter((row) =>
            !verdict
              ? true
              : verdict === 'unscored'
                ? row.verdict === null
                : row.verdict === verdict,
          )
          .slice(offset, offset + limit);
        return route.fulfill({ json: { jobs: rows, page: { limit, offset } } });
      },
      'POST /v1/jobs/:id/queue-bid': (_request, route) =>
        route.fulfill(
          options.queueBid ?? { status: 202, json: { action: 'drafting', jobId: READY.id } },
        ),
    },
    { role: options.role },
  );
  await page.goto('/feed.html');
  await expectStatus(page, /Loaded \d+ jobs\./);
  return requests;
}

test('lists jobs with the stored score, estimate, margin and bid state, formatted the one way', async ({
  page,
}) => {
  await open(page);
  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(4);
  const ready = rows.nth(0);
  await expect(ready).toContainText('Shopify store rebuild');
  await expect(ready).toContainText('R1 000,00 – R2 000,00');
  await expect(ready).toContainText('Go 82');
  await expect(ready).toContainText('R1 500,00 (rate card)');
  await expect(ready).toContainText('R750,00 (37,500%)');
  await expect(ready).toContainText('Passed');
  await expect(ready).toContainText('seen 22/09/2026 10:05');
  const queued = rows.nth(1);
  await expect(queued).toContainText('USD 500,00 per hour');
  await expect(queued).toContainText('Caution 61');
  await expect(queued).toContainText('unverified_payment');
  await expect(queued).toContainText('Waiting for approval');
  await expect(rows.nth(2)).toContainText('payment not verified');
  await expect(rows.nth(3)).toContainText('Not stated');
  await expect(rows.nth(3)).toContainText('Not scored');
  await expect(page.locator('#count')).toHaveText('Showing 1–4');
  await expect(page.getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page');
  await expectEveryLinkGoesSomewhere(page);
});

test('the verdict filter sends exactly that verdict and lands in the address bar', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('Verdict').selectOption('skip');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 job.');
  await expect(page.locator('#rows tr')).toHaveCount(1);
  expect(requests.at(-1)?.query.get('verdict')).toBe('skip');
  await expect(page).toHaveURL(/verdict=skip/);

  await page.getByLabel('Verdict').selectOption('unscored');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 job.');
  await expect(page.locator('#rows')).toContainText('Untouched job');
});

test('a linked view restores its filter', async ({ page }) => {
  await signedIn(page);
  const requests = await serveApi(page, {
    'GET /v1/jobs': (_request, route) =>
      route.fulfill({ json: { jobs: [SKIP], page: { limit: 25, offset: 0 } } }),
  });
  await page.goto('/feed.html?verdict=skip');
  await expectStatus(page, 'Loaded 1 job.');
  await expect(page.getByLabel('Verdict')).toHaveValue('skip');
  expect(requests.find((r) => r.path === '/v1/jobs')?.query.get('verdict')).toBe('skip');
});

test('an empty filter says so', async ({ page }) => {
  await signedIn(page);
  await serveApi(page, {
    'GET /v1/jobs': (_request, route) =>
      route.fulfill({ json: { jobs: [], page: { limit: 25, offset: 0 } } }),
  });
  await page.goto('/feed.html');
  await expectStatus(page, 'No jobs match this filter.');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#results')).toBeHidden();
});

test('refresh asks again; previous is off on page one and next is off on a short page', async ({
  page,
}) => {
  const requests = await open(page);
  const before = requests.filter((r) => r.path === '/v1/jobs').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expectStatus(page, 'Loaded 4 jobs.');
  expect(requests.filter((r) => r.path === '/v1/jobs').length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('pages through results', async ({ page }) => {
  await signedIn(page);
  const many = Array.from({ length: 30 }, (_, i) => job({ title: `Job ${String(i + 1)}` }));
  const requests = await serveApi(page, {
    'GET /v1/jobs': (request, route) => {
      const offset = Number(request.query.get('offset') ?? 0);
      return route.fulfill({
        json: { jobs: many.slice(offset, offset + 25), page: { limit: 25, offset } },
      });
    },
  });
  await page.goto('/feed.html');
  await expectStatus(page, 'Loaded 25 jobs.');
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expectStatus(page, 'Loaded 5 jobs.');
  expect(requests.at(-1)?.query.get('offset')).toBe('25');
  await expect(page.locator('#count')).toHaveText('Showing 26–30');
  await expect(page).toHaveURL(/offset=25/);
  await page.getByRole('button', { name: 'Previous' }).click();
  await expectStatus(page, 'Loaded 25 jobs.');
  expect(requests.at(-1)?.query.get('offset')).toBe('0');
});

test('Queue bid asks the API, reports the answer, and reloads the feed', async ({ page }) => {
  const requests = await open(page);
  const button = page.getByRole('button', { name: 'Queue bid for Shopify store rebuild' });
  await expect(button).toBeEnabled();
  await button.click();
  await expectStatus(
    page,
    'A bid for “Shopify store rebuild” is being drafted. It will appear in Approvals.',
  );
  const call = requests.find((r) => r.method === 'POST' && r.path.endsWith('/queue-bid'));
  expect(call?.path).toBe(`/v1/jobs/${READY.id}/queue-bid`);
  // The reload follows the success message, so wait for it rather than race it.
  await expect.poll(() => requests.filter((r) => r.path === '/v1/jobs').length).toBe(2);
});

test('a job that is scored first says so', async ({ page }) => {
  await open(page, { queueBid: { status: 202, json: { action: 'scoring', jobId: FRESH.id } } });
  await page.getByRole('button', { name: 'Queue bid for Untouched job' }).click();
  await expectStatus(page, /“Untouched job” is being scored first/);
});

test('the API’s refusal is shown as it is', async ({ page }) => {
  await open(page, {
    queueBid: {
      status: 422,
      json: { error: 'This job was scored skip, so no bid is drafted for it.' },
    },
  });
  await page.getByRole('button', { name: 'Queue bid for Pay us first' }).click();
  await expectStatus(page, 'This job was scored skip, so no bid is drafted for it.');
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
});

test('a plan limit is shown in the plan’s own words (ARB-410)', async ({ page }) => {
  const error =
    "The Test plan plan's monthly limit for drafting bids is reached: 20 of 20 used. It resets on 01/10/2026. Choose a bigger plan in Settings to go on now.";
  await open(page, { queueBid: { status: 402, json: { error } } });
  await page.getByRole('button', { name: 'Queue bid for Pay us first' }).click();
  await expectStatus(page, error);
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
});

test('Queue bid is off while a bid is already in play, with the reason in its title', async ({
  page,
}) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Queue bid for Landing page, urgent' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'A bid is already waiting for approval.');
});

test('a viewer can read the feed but every Queue bid is off', async ({ page }) => {
  await open(page, { role: 'viewer' });
  const buttons = page.getByRole('button', { name: /^Queue bid for/ });
  await expect(buttons).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    await expect(buttons.nth(i)).toBeDisabled();
    await expect(buttons.nth(i)).toHaveAttribute(
      'title',
      'Your role can view the feed but not queue bids.',
    );
  }
});

test('an Upwork job is read only: Queue bid is off, saying to bid on Upwork itself', async ({
  page,
}) => {
  await open(page, { jobs: [job({ title: 'Upwork build', platform: 'upwork' }), READY] });
  const upwork = page.getByRole('button', { name: 'Queue bid for Upwork build' });
  await expect(upwork).toBeDisabled();
  await expect(upwork).toHaveAttribute(
    'title',
    'Upwork jobs are read only here: bid on Upwork itself (docs/01 section B).',
  );
  await expect(page.locator('#rows tr').first()).toContainText('upwork');
  await expect(page.getByRole('button', { name: `Queue bid for ${READY.title}` })).toBeEnabled();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});
