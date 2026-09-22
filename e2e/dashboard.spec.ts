import { expect, test, type Page } from '@playwright/test';
import {
  API,
  SESSION,
  SUPABASE,
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Captured,
} from './helpers.js';

/** The figures apps/api/src/routes/dashboard.ts returns for its own test data. */
const DASHBOARD = {
  period: { start: '2026-08-31T22:00:00.000Z', end: '2026-09-22T10:00:00.000Z' },
  currency: 'ZAR',
  revenueInZarMinor: '390000',
  revenueOutZarMinor: '120000',
  realisedMarginZarMinor: '270000',
  unconverted: [{ direction: 'in', currency: 'USD', amountMinor: '10000', count: 1 }],
  pipeline: [{ currency: 'ZAR', amountMinor: '600000', count: 2 }],
  replies: 1,
  bids: { queued: 3, submitted: 1, won: 1, lost: 1 },
  winRate: 0.5,
  retainers: [{ currency: 'ZAR', amountMinor: '50000', count: 1 }],
};

async function open(page: Page, body = DASHBOARD): Promise<Captured[]> {
  await signedIn(page);
  const requests = await serveApi(page, {
    'GET /v1/dashboard': (_request, route) => route.fulfill({ json: body }),
  });
  await page.goto('/dashboard.html');
  await expectStatus(page, 'Figures are up to date.');
  return requests;
}

test('shows every figure formatted the one way the app allows, from the API alone', async ({
  page,
}) => {
  const requests = await open(page);
  expect(requests.find((r) => r.path === '/v1/dashboard')?.auth).toBe(
    `Bearer ${SESSION.access_token}`,
  );
  await expect(page.locator('#period')).toHaveText(
    'Month to date: 01/09/2026 to 22/09/2026, South African time.',
  );
  await expect(page.locator('#revenue-in')).toHaveText('R3 900,00');
  await expect(page.locator('#revenue-out')).toHaveText('R1 200,00');
  await expect(page.locator('#margin')).toHaveText('R2 700,00');
  await expect(page.locator('#pipeline')).toHaveText('R6 000,00');
  await expect(page.locator('#pipeline-note')).toHaveText(
    '2 open deals, applied through delivered.',
  );
  await expect(page.locator('#replies')).toHaveText('1');
  await expect(page.locator('#win-rate')).toHaveText('50,0%');
  await expect(page.locator('#win-rate-note')).toHaveText('1 won, 1 lost this month.');
  await expect(page.locator('#retainers')).toHaveText('R500,00');
  await expect(page.locator('#bids')).toHaveText('3 waiting');
  await expect(page.locator('#unconverted')).toBeVisible();
  await expect(page.locator('#unconverted-list li')).toHaveText(
    'Received USD 100,00 across 1 payment.',
  );
  await expect(page.locator('#who')).toHaveText('Ayanda Nkosi · owner · Logi-Ink');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('an empty month reads as zero, with no decisions and nothing unconverted', async ({
  page,
}) => {
  await open(page, {
    ...DASHBOARD,
    revenueInZarMinor: '0',
    revenueOutZarMinor: '0',
    realisedMarginZarMinor: '0',
    unconverted: [],
    pipeline: [],
    bids: { queued: 0, submitted: 0, won: 0, lost: 0 },
    winRate: null,
    retainers: [],
  });
  await expect(page.locator('#revenue-in')).toHaveText('R0,00');
  await expect(page.locator('#pipeline')).toHaveText('R0,00');
  await expect(page.locator('#win-rate')).toHaveText('No decisions yet');
  await expect(page.locator('#unconverted')).toBeHidden();
});

test('refresh asks the API again', async ({ page }) => {
  const requests = await open(page);
  const before = requests.filter((r) => r.path === '/v1/dashboard').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expectStatus(page, 'Figures are up to date.');
  expect(requests.filter((r) => r.path === '/v1/dashboard').length).toBe(before + 1);
});

test('the bids tile links to approvals', async ({ page }) => {
  await open(page);
  await expect(page.locator('#bids-link')).toHaveAttribute('href', './approvals.html');
  await expect(page.locator('#bids-link')).toHaveText('1 sent this month. Open approvals');
});

test('an API failure is shown in the status line', async ({ page }) => {
  await signedIn(page);
  await serveApi(page, {
    'GET /v1/dashboard': (_request, route) =>
      route.fulfill({ status: 500, json: { error: 'boom' } }),
  });
  await page.goto('/dashboard.html');
  await expectStatus(page, 'The API refused the request: boom.');
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
});

test('without a session the page goes to login, remembering where it was', async ({ page }) => {
  await page.goto('/dashboard.html');
  await page.waitForURL('**/login.html?next=dashboard.html');
});

test('a session the API no longer accepts is dropped and the page goes to login', async ({
  page,
}) => {
  await signedIn(page);
  await serveApi(page, {
    'GET /v1/me': (_request, route) =>
      route.fulfill({ status: 401, json: { error: 'not signed in' } }),
  });
  await page.goto('/dashboard.html');
  await page.waitForURL('**/login.html?next=dashboard.html');
  expect(await page.evaluate(() => sessionStorage.getItem('arbitron.session'))).toBeNull();
});

test('sign out revokes the session with Supabase, clears it, and goes to login', async ({
  page,
}) => {
  const logouts: string[] = [];
  await page.route(`${SUPABASE}/**`, async (route) => {
    logouts.push(
      `${route.request().method()} ${route.request().url()} ${route.request().headers()['authorization']}`,
    );
    await route.fulfill({ status: 204 });
  });
  await open(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login.html');
  expect(logouts).toEqual([`POST ${SUPABASE}/auth/v1/logout Bearer ${SESSION.access_token}`]);
  expect(await page.evaluate(() => sessionStorage.getItem('arbitron.session'))).toBeNull();
  // And the login page is shown, not bounced back: there is no session any more.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});

test('the API is called at the configured base URL', async ({ page }) => {
  const requests = await open(page);
  expect(requests[0]?.path.startsWith('/v1/')).toBe(true);
  expect(API).toBe('https://e2e-api.invalid');
});
