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

/**
 * ARB-320: the analytics page. The API is an in-memory copy, at the network edge, of
 * apps/api/src/routes/analytics.ts (tested against real Postgres and raw SQL in
 * routes/analytics.test.ts); the figures are the ones hand-worked in
 * packages/core/src/analytics.test.ts.
 */
const ratio = (numerator: number, denominator: number, percent: string | null) => ({
  numerator,
  denominator,
  percent,
});

const WEB = {
  key: 'web-design',
  label: 'Web design',
  bids: 3,
  replies: 2,
  replyRate: ratio(2, 3, '66.7'),
  won: 1,
  lost: 1,
  winRate: ratio(1, 2, '50.0'),
  realisedMarginZarMinor: '449950',
  unconvertedPayments: 0,
  modelCostNanoUsd: '4500000',
  costPerReplyNanoUsd: '2250000',
};
const UNCLASSIFIED = {
  key: null,
  label: 'Not classified',
  bids: 1,
  replies: 0,
  replyRate: ratio(0, 1, '0.0'),
  won: 0,
  lost: 0,
  winRate: ratio(0, 0, null),
  realisedMarginZarMinor: '0',
  unconvertedPayments: 1,
  modelCostNanoUsd: '0',
  costPerReplyNanoUsd: null,
};
const TOTAL = {
  ...WEB,
  key: 'all',
  label: 'All bids',
  bids: 4,
  replyRate: ratio(2, 4, '50.0'),
  unconvertedPayments: 1,
};

async function serve(page: Page, options: { role?: Role; none?: boolean } = {}) {
  await signedIn(page);
  return serveApi(
    page,
    {
      'GET /v1/analytics': (req, route) => {
        const by = req.query.get('by') ?? 'category';
        if (options.none)
          return route.fulfill({
            json: { by, since: null, total: { ...UNCLASSIFIED, bids: 0 }, rows: [] },
          });
        const rows =
          by === 'supplier'
            ? [
                { ...WEB, key: 's1', label: 'Thandi' },
                { ...UNCLASSIFIED, label: 'No supplier' },
              ]
            : [WEB, UNCLASSIFIED];
        return route.fulfill({ json: { by, since: req.query.get('since'), total: TOTAL, rows } });
      },
    },
    { role: options.role },
  );
}

async function open(
  page: Page,
  options: { role?: Role; none?: boolean } = {},
): Promise<Captured[]> {
  const requests = await serve(page, options);
  await page.goto('/analytics.html');
  await expectStatus(page, /^Counted \d+ bids? by \w+\.$|^No bids sent yet\.$/);
  return requests;
}

test('shows each group’s figures as the API worked them, with the total, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Counted 4 bids by category.');
  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(
    /Web design\s*3\s*66,7 % \(2 of 3\)\s*50,0 % \(1 of 2\)\s*R4.499,50\s*USD 0,00225/,
  );
  // A rate with nothing under it says so; a group with no replies has no cost per reply.
  await expect(rows.nth(1)).toContainText('No data (0 of 0)');
  await expect(rows.nth(1)).toContainText('No replies');
  await expect(page.locator('#total')).toContainText('All bids');
  await expect(page.locator('#unconverted')).toHaveText(
    '1 payment not in rand with no rate is left out of realised margin; record its rate on the pipeline page.',
  );
  await expect(page.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('Group by and a start date ask the API again, and land in the address bar', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('Group by').selectOption('supplier');
  await page.getByLabel('Bids sent since (DD/MM/YYYY)').fill('01/09/2026');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expectStatus(page, 'Counted 4 bids by supplier.');
  const last = requests.filter((r) => r.path === '/v1/analytics').at(-1);
  expect(last?.query.get('by')).toBe('supplier');
  expect(last?.query.get('since')).toBe('2026-09-01');
  await expect(page.locator('#group-heading')).toHaveText('Supplier');
  await expect(page.locator('#rows tr').first()).toContainText('Thandi');
  await expect(page).toHaveURL(/by=supplier&since=2026-09-01/);
});

test('a false date is refused on its field, and nothing is asked', async ({ page }) => {
  const requests = await open(page);
  const before = requests.length;
  await page.getByLabel('Bids sent since (DD/MM/YYYY)').fill('31/02/2026');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('#since-error')).toHaveText('Must be a real date as DD/MM/YYYY.');
  expect(requests.length).toBe(before);
});

test('a linked view opens with its grouping and date', async ({ page }) => {
  const requests = await serve(page);
  await page.goto('/analytics.html?by=template&since=2026-09-01');
  await expectStatus(page, 'Counted 4 bids by template.');
  await expect(page.getByLabel('Group by')).toHaveValue('template');
  await expect(page.getByLabel('Bids sent since (DD/MM/YYYY)')).toHaveValue('01/09/2026');
  expect(requests.find((r) => r.path === '/v1/analytics')?.query.get('since')).toBe('2026-09-01');
});

test('with no bids sent, the page says there is nothing to count', async ({ page }) => {
  await open(page, { none: true });
  await expectStatus(page, 'No bids sent yet.');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#results')).toBeHidden();
});

test('a viewer reads the same figures', async ({ page }) => {
  await open(page, { role: 'viewer' });
  await expect(page.locator('#rows tr')).toHaveCount(2);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});
