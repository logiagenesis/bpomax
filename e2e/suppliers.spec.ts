import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
 * ARB-200: the suppliers page. The API is an in-memory copy, at the network edge, of
 * routes/suppliers.ts (tested against real Postgres in routes/suppliers.test.ts):
 * GET /v1/suppliers, GET /v1/suppliers/template.csv, GET /v1/suppliers.csv and
 * POST /v1/suppliers/import; and of GET /v1/service-categories.
 */
const HEADING =
  'name,country_code,time_zone,channel,languages,quality_score,on_time_rate,pays_after_delivery,external_profile_url,notes,active,category_slug,currency,fixed_price,hourly_rate,turnaround_days';
const TEMPLATE = `${HEADING}\r\nExample Supplier (sample),ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,https://example.com/profile,Replace this line with your suppliers; one line per supplier and rate card.,yes,wordpress,ZAR,1500.00,,5\r\n`;
const EXPORT = `${HEADING}\r\nStudio Nord,NO,Europe/Oslo,upwork,en,,,no,,,no,,,,,\r\nThandi Web,ZA,Africa/Johannesburg,direct,en;zu,85.00,0.950,yes,,,yes,wordpress,ZAR,1500.00,,5\r\n`;
const GOOD = [
  HEADING,
  'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,,,yes,wordpress,ZAR,"1 500,00",,5',
  'Studio Nord,NO,Europe/Oslo,upwork,en,,,no,,,no,,,,,',
].join('\n');
const BAD = [
  HEADING,
  ',ZA,,direct,,,,yes,,,yes,,,,,',
  'Bad,ZA,,telepathy,,,,yes,,,yes,plumbing,ZAR,abc,,',
].join('\n');

const THANDI = {
  id: 's1',
  name: 'Thandi Web',
  countryCode: 'ZA',
  timeZone: 'Africa/Johannesburg',
  channel: 'direct',
  languages: ['en', 'zu'],
  qualityScore: '85.00',
  onTimeRate: '0.950',
  paysAfterDelivery: true,
  externalProfileUrl: 'https://example.com/thandi',
  notes: 'Fast, careful',
  active: true,
  rateCards: [
    {
      id: 'r1',
      categorySlug: 'wordpress',
      categoryName: 'WordPress',
      currency: 'ZAR',
      fixedPriceMinor: '150000',
      hourlyRateMinor: null,
      turnaroundDays: 5,
    },
    {
      id: 'r2',
      categorySlug: 'seo',
      categoryName: 'SEO',
      currency: 'ZAR',
      fixedPriceMinor: null,
      hourlyRateMinor: '35050',
      turnaroundDays: null,
    },
  ],
  createdAt: '2026-09-20T08:00:00Z',
  updatedAt: '2026-09-20T08:00:00Z',
};
const NORD = {
  ...THANDI,
  id: 's2',
  name: 'Studio Nord',
  countryCode: 'NO',
  timeZone: 'Europe/Oslo',
  channel: 'upwork',
  languages: ['en'],
  qualityScore: null,
  onTimeRate: null,
  paysAfterDelivery: false,
  externalProfileUrl: null,
  notes: null,
  active: false,
  rateCards: [],
};

interface Options {
  role?: Role;
  suppliers?: unknown[];
  importResult?: { status: number; json: unknown };
}

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  let suppliers = options.suppliers ?? [NORD, THANDI];
  return serveApi(
    page,
    {
      'GET /v1/service-categories': (_request, route) =>
        route.fulfill({
          json: {
            categories: [
              { slug: 'wordpress', name: 'WordPress', inHouse: true },
              { slug: 'seo', name: 'SEO', inHouse: false },
            ],
          },
        }),
      'GET /v1/suppliers/template.csv': (_request, route) =>
        route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="suppliers-template.csv"',
            'access-control-expose-headers':
              'content-disposition, x-export-rows, x-export-truncated',
          },
          body: TEMPLATE,
        }),
      'GET /v1/suppliers.csv': (_request, route) =>
        route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="suppliers-20260923.csv"',
            'x-export-rows': '2',
            'x-export-truncated': 'false',
            'access-control-expose-headers':
              'content-disposition, x-export-rows, x-export-truncated',
          },
          body: EXPORT,
        }),
      'GET /v1/suppliers': (_request, route) => route.fulfill({ json: { suppliers } }),
      'POST /v1/suppliers/import': (request, route) => {
        if (options.importResult) return route.fulfill(options.importResult);
        const body = request.body as { csv: string; dryRun?: boolean };
        const lines = body.csv.trim().split('\n').length - 1;
        if (!body.dryRun) suppliers = [NORD, THANDI, { ...THANDI, id: 's3', name: 'Imported One' }];
        return route.fulfill({
          json: {
            ok: true,
            dryRun: body.dryRun === true,
            lines,
            suppliers: 2,
            rateCards: 1,
            created: body.dryRun ? 0 : 1,
            updated: body.dryRun ? 0 : 1,
          },
        });
      },
    },
    { role: options.role },
  );
}

async function open(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await serve(page, options);
  await page.goto('/suppliers.html');
  await expectStatus(page, /Loaded \d+ suppliers?\.|No suppliers yet\./);
  return requests;
}

test('lists suppliers with their rate cards in the one money format, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Loaded 2 suppliers.');
  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Studio Nord');
  await expect(rows.nth(0)).toContainText('Upwork · NO · Europe/Oslo · en');
  await expect(rows.nth(0)).toContainText('Not recorded');
  await expect(rows.nth(0)).toContainText('None');
  await expect(rows.nth(0)).toContainText('Inactive');
  await expect(rows.nth(1)).toContainText('Thandi Web');
  await expect(rows.nth(1)).toContainText('85 / 100, 95,0% on time');
  await expect(rows.nth(1)).toContainText('WordPress: R1 500,00 fixed, 5 days');
  await expect(rows.nth(1)).toContainText('SEO: R350,50 an hour');
  await expect(rows.nth(1).getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    'https://example.com/thandi',
  );
  await expect(page.locator('#count')).toHaveText('2 suppliers, 2 rate cards.');
  await expect(page.getByRole('link', { name: 'Suppliers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const hrefs = await page
    .locator('a:not([target="_blank"])')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  for (const href of hrefs) expect(href).toMatch(/^\.\/[a-z-]+\.html(\?.*)?$/);
});

test('an empty database says what to do next', async ({ page }) => {
  await open(page, { suppliers: [] });
  await expectStatus(page, 'No suppliers yet.');
  await expect(page.locator('#empty')).toContainText(
    'Download the template, fill it in and import it.',
  );
  await expect(page.locator('#results')).toBeHidden();
  await expectEveryLinkGoesSomewhere(page);
});

test('Download the template saves the file the API serves', async ({ page }) => {
  const requests = await open(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the template' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('suppliers-template.csv');
  expect(readFileSync(await download.path(), 'utf8')).toBe(TEMPLATE);
  await expectStatus(page, 'Downloaded the template. Replace its sample line with your suppliers.');
  expect(requests.some((r) => r.path === '/v1/suppliers/template.csv')).toBe(true);
});

test('Export CSV saves the database as the API serves it, and says how many', async ({ page }) => {
  await open(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('suppliers-20260923.csv');
  expect(readFileSync(await download.path(), 'utf8')).toBe(EXPORT);
  await expectStatus(page, 'Exported 2 suppliers.');
});

test('a file with problems is refused on the page with every problem on its line, and nothing is sent', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expect(page.locator('#import-file-error')).toHaveText(
    'Choose a file or paste the CSV first.',
  );
  await page.getByLabel('Or paste the CSV').fill(BAD);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expectStatus(page, '2 lines have problems; nothing was imported.');
  const problems = page.locator('#import-errors li');
  await expect(problems).toHaveCount(4);
  await expect(problems.nth(0)).toHaveText('Line 2, name: must not be empty.');
  await expect(problems.nth(1)).toContainText('Line 3, channel: must be one of');
  await expect(problems.nth(2)).toHaveText('Line 3, category_slug: is not a service category.');
  await expect(problems.nth(3)).toHaveText(
    'Line 3, fixed_price: must be an amount such as 1500.00.',
  );
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
});

test('Check the file asks the API to check without writing', async ({ page }) => {
  const requests = await open(page);
  await page.getByLabel('Or paste the CSV').fill(GOOD);
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expectStatus(page, 'The file is fine: 2 suppliers and 1 rate card would be imported.');
  const call = requests.find((r) => r.method === 'POST');
  expect(call?.path).toBe('/v1/suppliers/import');
  expect(call?.body).toEqual({ csv: GOOD, dryRun: true });
  expect(requests.filter((r) => r.path === '/v1/suppliers')).toHaveLength(1);
});

test('Import the file sends a chosen file as text, reports the counts and reloads the list', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'suppliers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(GOOD, 'utf8'),
  });
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expectStatus(page, 'Imported 2 suppliers and 1 rate card (1 new, 1 updated).');
  const call = requests.find((r) => r.method === 'POST');
  expect(call?.body).toEqual({ csv: GOOD, dryRun: false });
  await expect(page.locator('#rows tr')).toHaveCount(3);
  await expect(page.locator('#rows')).toContainText('Imported One');
  await expect(page.locator('#import-summary')).toHaveText(
    'Imported 2 suppliers and 1 rate card (1 new, 1 updated).',
  );
});

test('the API’s own line problems are shown the same way', async ({ page }) => {
  await open(page, {
    importResult: {
      status: 422,
      json: {
        error: '1 line has problems; nothing was imported.',
        errors: [{ line: 2, field: 'category_slug', message: 'is not a service category' }],
      },
    },
  });
  await page.getByLabel('Or paste the CSV').fill(GOOD);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expectStatus(page, '1 line has problems; nothing was imported.');
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
  await expect(page.locator('#import-errors li')).toHaveText([
    'Line 2, category_slug: is not a service category.',
  ]);
});

test('a viewer can read and download but not import, with the reason in the title', async ({
  page,
}) => {
  await open(page, { role: 'viewer' });
  for (const name of ['Check the file', 'Import the file']) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      'title',
      'Your role can view suppliers but not import them.',
    );
  }
  await expect(page.getByRole('button', { name: 'Download the template' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});
