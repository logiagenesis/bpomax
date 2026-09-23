import { expect, test } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
} from './helpers.js';

/**
 * ARB-020: the page Freelancer.com returns the browser to with `?code=`. The API's
 * callback route is answered at the network edge in the shape
 * apps/api/src/routes/platform-accounts.ts returns (tested there against real Postgres
 * and the Freelancer.com stand-in).
 */
const ACCOUNT = {
  id: 'aaaaaaaa-0000-4000-8000-000000000005',
  platform: 'freelancer',
  externalUserId: '424242',
  externalUsername: 'logiink',
  status: 'connected',
  scopes: ['basic', '1', '2', '5', '6'],
  lastSyncAt: null,
  planName: null,
  monthlyBidAllowance: null,
  planRecordedOn: null,
};

test('hands the code to the API, says which account was connected, and clears the code from the address', async ({
  page,
}) => {
  await signedIn(page);
  const requests = await serveApi(page, {
    'POST /v1/platform-accounts/freelancer/callback': (_request, route) =>
      route.fulfill({ status: 201, json: { account: ACCOUNT } }),
  });
  await page.goto('/freelancer-callback.html?code=code-from-freelancer');
  await expectStatus(page, 'Connected the Freelancer.com account logiink.');
  const call = requests.find((r) => r.path === '/v1/platform-accounts/freelancer/callback');
  expect(call?.body).toEqual({ code: 'code-from-freelancer' });
  expect(page.url()).not.toContain('code=');
  await expect(page.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
    'href',
    './settings.html',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('without a code nothing is sent, and the page says what to do', async ({ page }) => {
  await signedIn(page);
  const requests = await serveApi(page, {});
  await page.goto('/freelancer-callback.html');
  await expectStatus(
    page,
    'Freelancer.com did not send back an authorisation code, so nothing was connected. Go back to Settings and try again.',
  );
  expect(requests.filter((r) => r.path.includes('/callback'))).toHaveLength(0);
});

test('the API’s refusal is shown as it is', async ({ page }) => {
  await signedIn(page);
  await serveApi(page, {
    'POST /v1/platform-accounts/freelancer/callback': (_request, route) =>
      route.fulfill({
        status: 409,
        json: {
          error:
            'This Freelancer.com account is already connected to another organisation; one account per verified identity (docs/01 section H).',
        },
      }),
  });
  await page.goto('/freelancer-callback.html?code=x');
  await expectStatus(
    page,
    'This Freelancer.com account is already connected to another organisation; one account per verified identity (docs/01 section H).',
  );
});

test('Back to Settings goes to Settings', async ({ page }) => {
  await signedIn(page);
  await serveApi(page, {
    'GET /v1/settings': (_request, route) => route.fulfill({ status: 500, json: { error: 'x' } }),
    'GET /v1/scanners': (_request, route) => route.fulfill({ json: { scanners: [] } }),
  });
  await page.goto('/freelancer-callback.html');
  await page.getByRole('link', { name: 'Back to Settings' }).click();
  await expect(page).toHaveURL(/\/settings\.html$/);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await signedIn(page);
  await serveApi(page, {});
  await page.goto('/freelancer-callback.html');
  await expectNoSidewaysScroll(page);
});
