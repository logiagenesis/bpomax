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
 * ARB-201: the sourcing page. The API is an in-memory copy, at the network edge, of
 * routes/sourcing.ts (tested against real Postgres in routes/sourcing.test.ts):
 * GET /v1/sourcing-requests, GET /v1/sourcing-requests/:id and
 * PATCH /v1/sourcing-requests/:id/candidates/:candidateId. The scores are the ones
 * hand-worked in packages/core/src/sourcing.test.ts.
 */
const REQUEST = 'aaaaaaaa-0000-4000-8000-000000000071';
const THANDI = 'aaaaaaaa-0000-4000-8000-000000000081';
const NORD = 'aaaaaaaa-0000-4000-8000-000000000082';

function candidates(shortlisted: string[] = []) {
  return [
    {
      id: THANDI,
      supplierId: 's1',
      name: 'Thandi Web',
      channel: 'direct',
      countryCode: 'ZA',
      timeZone: 'Africa/Johannesburg',
      currency: 'ZAR',
      quotedPriceMinor: '900000',
      priced: 'fixed',
      turnaroundDays: 5,
      score: 98,
      parts: { rate: 40, turnaround: 20, quality: 18, timeZone: 10, paysAfterDelivery: 10 },
      reasons: [
        'R9 000,00 is within the budget R10 000,00 – R20 000,00',
        "5 days' turnaround fits the 20 days left to the deadline",
        'quality 85 of 100, 95 % on time',
        'the same time zone as Pretoria',
        'accepts payment after delivery',
      ],
      shortlisted: shortlisted.includes(THANDI),
    },
    {
      id: NORD,
      supplierId: 's2',
      name: 'Studio Nord',
      channel: 'upwork',
      countryCode: 'NO',
      timeZone: 'Europe/Oslo',
      currency: 'ZAR',
      quotedPriceMinor: '1500000',
      priced: 'fixed',
      turnaroundDays: 30,
      score: 57,
      parts: { rate: 30, turnaround: 10, quality: 7, timeZone: 10, paysAfterDelivery: 0 },
      reasons: [
        'R15 000,00 is within the budget R10 000,00 – R20 000,00',
        "30 days' turnaround would miss the deadline by 10 days; the deadline is flexible",
        'quality 60 of 100, no on-time rate recorded',
        'the same time zone as Pretoria',
        'wants payment before delivery',
      ],
      shortlisted: shortlisted.includes(NORD),
    },
  ];
}

function request(shortlisted: string[] = [], partial: Record<string, unknown> = {}) {
  const list = candidates(shortlisted);
  return {
    id: REQUEST,
    briefId: 'b1',
    briefVersion: 1,
    briefTitle: 'Shopify store rebuild',
    category: 'wordpress',
    deliveryRoute: 'supplier',
    threadId: 't1',
    clientHandle: 'acme-shop',
    jobTitle: 'Shopify store rebuild',
    channels: ['direct', 'upwork'],
    status: shortlisted.length > 0 ? 'shortlisting' : 'open',
    candidateCount: list.length,
    shortlistedCount: shortlisted.length,
    excluded: [
      {
        supplierId: 's3',
        name: 'Dollar Shop',
        reason: 'no ZAR rate card for wordpress; conversion is not guessed',
      },
      { supplierId: 's4', name: 'No Card', reason: 'no rate card for wordpress' },
    ],
    createdAt: '2026-09-23T10:00:00Z',
    updatedAt: '2026-09-23T10:00:00Z',
    candidates: list,
    ...partial,
  };
}

interface Options {
  role?: Role;
  /** No requests at all, for the empty state. */
  none?: boolean;
  /** Fields that differ from the sample request, such as its status. */
  partial?: Record<string, unknown>;
  patch?: { status: number; json: unknown };
}

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  let shortlisted: string[] = [];
  const current = () => request(shortlisted, options.partial ?? {});
  const summary = () => {
    const { candidates: _candidates, ...rest } = current();
    return rest;
  };
  return serveApi(
    page,
    {
      'GET /v1/sourcing-requests': (_request, route) =>
        route.fulfill({ json: { requests: options.none ? [] : [summary()] } }),
      'GET /v1/sourcing-requests/:id': (req, route) => {
        const id = req.path.split('/').pop();
        if (id !== REQUEST)
          return route.fulfill({ status: 404, json: { error: 'no such sourcing request' } });
        return route.fulfill({ json: { request: current() } });
      },
      'PATCH /v1/sourcing-requests/:id/candidates/:candidateId': (req, route) => {
        if (options.patch) return route.fulfill(options.patch);
        const candidate = req.path.split('/').pop() ?? '';
        const body = req.body as { shortlisted: boolean };
        shortlisted = body.shortlisted
          ? [...new Set([...shortlisted, candidate])]
          : shortlisted.filter((c) => c !== candidate);
        return route.fulfill({ json: { request: request(shortlisted) } });
      },
    },
    { role: options.role },
  );
}

async function open(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await serve(page, options);
  await page.goto('/sourcing.html');
  await expectStatus(page, /Loaded \d+ sourcing requests?\.|No sourcing requests yet\./);
  return requests;
}

async function openRequest(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await open(page, options);
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild' })
    .click();
  await expect(page.locator('#request-status')).toHaveText(
    'Opened the sourcing request for Shopify store rebuild: 2 suppliers ranked, 2 not ranked.',
  );
  return requests;
}

test('lists the requests with where each stands, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Loaded 1 sourcing request.');
  const row = page.locator('#rows tr').first();
  await expect(row).toContainText('Shopify store rebuild');
  await expect(row).toContainText('acme-shop · version 1');
  await expect(row).toContainText('wordpress');
  await expect(row).toContainText('Open');
  await expect(row).toContainText('2 ranked, 0 shortlisted');
  await expect(row).toContainText('23/09/2026 12:00');
  await expect(page.locator('#request')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Sourcing' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('an empty list says what to do', async ({ page }) => {
  await open(page, { none: true });
  await expectStatus(page, 'No sourcing requests yet.');
  await expect(page.locator('#empty')).toContainText(
    'Lock a brief on its conversation and press Start sourcing.',
  );
});

test('Open shows the ranking in order with the rate, the score, every reason, and who was left out and why', async ({
  page,
}) => {
  await openRequest(page);
  await expect(page.locator('#request-title')).toHaveText('Sourcing for Shopify store rebuild');
  await expect(page.locator('#request-meta')).toContainText('route an existing supplier');
  const rows = page.locator('#candidate-rows tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1');
  await expect(rows.nth(0)).toContainText('Thandi Web');
  await expect(rows.nth(0)).toContainText('Direct · ZA · Africa/Johannesburg');
  await expect(rows.nth(0)).toContainText('R9 000,00 fixed');
  await expect(rows.nth(0)).toContainText('5 days');
  await expect(rows.nth(0)).toContainText('98 / 100');
  await expect(rows.nth(0)).toContainText(
    'rate 40, turnaround 20, quality 18, time zone 10, payment 10',
  );
  await expect(rows.nth(0).locator('li')).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('accepts payment after delivery');
  await expect(rows.nth(1)).toContainText('Studio Nord');
  await expect(rows.nth(1)).toContainText('R15 000,00 fixed');
  await expect(rows.nth(1)).toContainText('57 / 100');
  await expect(rows.nth(1)).toContainText(
    "30 days' turnaround would miss the deadline by 10 days; the deadline is flexible",
  );
  await expect(page.locator('#excluded li')).toHaveText([
    'Dollar Shop: no ZAR rate card for wordpress; conversion is not guessed.',
    'No Card: no rate card for wordpress.',
  ]);
  await expect(page).toHaveURL(new RegExp(`request=${REQUEST}`));
  await expect(page.locator('#rows tr').first()).toHaveAttribute('aria-current', 'true');
});

test('a linked view opens its request', async ({ page }) => {
  await serve(page);
  await page.goto(`/sourcing.html?request=${REQUEST}`);
  await expect(page.locator('#request-status')).toHaveText(
    'Opened the sourcing request for Shopify store rebuild: 2 suppliers ranked, 2 not ranked.',
  );
  await expect(page.locator('#candidate-rows tr')).toHaveCount(2);
  await expectStatus(page, 'Loaded 1 sourcing request.');
});

test('a request the API cannot find says so', async ({ page }) => {
  await serve(page);
  await page.goto('/sourcing.html?request=aaaaaaaa-0000-4000-8000-000000000099');
  await expect(page.locator('#request-status')).toHaveText(
    'The API refused the request: no such sourcing request.',
  );
});

test('Shortlist and Remove ask the API, flip the button, and the list follows', async ({
  page,
}) => {
  const requests = await openRequest(page);
  await page.getByRole('button', { name: 'Shortlist Studio Nord' }).click();
  await expect(page.locator('#request-status')).toHaveText('Shortlisted Studio Nord.');
  const call = requests.find((r) => r.method === 'PATCH');
  expect(call?.path).toBe(`/v1/sourcing-requests/${REQUEST}/candidates/${NORD}`);
  expect(call?.body).toEqual({ shortlisted: true });
  await expect(page.locator('#candidate-rows tr').nth(1)).toHaveAttribute(
    'data-shortlisted',
    'true',
  );
  await expect(page.locator('#request-meta')).toContainText('Shortlisting');
  await expect(page.locator('#rows tr').first()).toContainText('2 ranked, 1 shortlisted');
  await page.getByRole('button', { name: 'Remove Studio Nord from the shortlist' }).click();
  await expect(page.locator('#request-status')).toHaveText(
    'Removed Studio Nord from the shortlist.',
  );
  expect(requests.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({ shortlisted: false });
  await expect(page.locator('#rows tr').first()).toContainText('2 ranked, 0 shortlisted');
});

test('the API’s refusal is shown as it is', async ({ page }) => {
  await openRequest(page, {
    patch: {
      status: 409,
      json: { error: 'This request is closed, so its shortlist cannot change.' },
    },
  });
  await page.getByRole('button', { name: 'Shortlist Thandi Web' }).click();
  await expect(page.locator('#request-status')).toHaveText(
    'This request is closed, so its shortlist cannot change.',
  );
  await expect(page.locator('#request-status')).toHaveClass(/alert--error/);
});

test('a request with a supplier chosen keeps its shortlist fixed, with the reason', async ({
  page,
}) => {
  await openRequest(page, { partial: { status: 'chosen' } });
  const button = page.getByRole('button', { name: 'Shortlist Thandi Web' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute(
    'title',
    'This request is supplier chosen, so its shortlist cannot change.',
  );
});

test('a viewer can read everything but not shortlist', async ({ page }) => {
  await openRequest(page, { role: 'viewer' });
  for (const name of ['Shortlist Thandi Web', 'Shortlist Studio Nord']) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Your role can view sourcing but not change it.');
  }
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openRequest(page);
  await expectNoSidewaysScroll(page);
});
