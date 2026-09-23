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
 * ARB-061: settings. The API is an in-memory copy of what apps/api/src/routes/settings.ts
 * and routes/scanners.ts answer, so a saved change is visible on the next read the way
 * it would be for real.
 */
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000005';
const SCANNER = 'aaaaaaaa-0000-4000-8000-000000000006';

const FEE_RULE = {
  platform: 'freelancer',
  project_type: 'fixed',
  side: 'freelancer',
  percent: 10,
  min_minor: 500,
  min_currency: 'USD',
  source_url: 'https://www.freelancer.com/feesandcharges',
  read_on: '2026-09-22',
};

function blockersOf(s: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (s.minMarginPct === null) missing.push('minimum margin % (docs/02 D-02)');
  if (s.minMarginZarMinor === null) missing.push('minimum margin in rand (docs/02 D-02)');
  if (s.fxBufferPct === null) missing.push('FX buffer % (docs/02 D-03)');
  if ((s.feeTable as unknown[]).length === 0) missing.push('at least one fee rule (docs/02 T-02)');
  if (s.retentionDays === null) missing.push('the retention period (docs/02 T-06)');
  return missing;
}

interface Options {
  role?: Role;
  complete?: boolean;
  environmentLiveMode?: boolean;
}

async function open(page: Page, options: Options = {}) {
  const settings: Record<string, unknown> = options.complete
    ? {
        minMarginPct: '25.000',
        minMarginZarMinor: '150000',
        fxBufferPct: '3.500',
        vatPct: '15.000',
        retentionDays: 365,
        feeTable: [FEE_RULE],
        liveMode: false,
        biddingPaused: false,
        updatedAt: '2026-09-22T08:00:00Z',
      }
    : {
        minMarginPct: null,
        minMarginZarMinor: null,
        fxBufferPct: null,
        vatPct: '15.000',
        retentionDays: null,
        feeTable: [],
        liveMode: false,
        biddingPaused: false,
        updatedAt: null,
      };
  const account: Record<string, unknown> = {
    id: ACCOUNT,
    platform: 'freelancer',
    externalUserId: 'ext-a',
    status: 'connected',
    scopes: [],
    lastSyncAt: null,
    planName: null,
    monthlyBidAllowance: null,
    planRecordedOn: null,
  };
  const scanners: Record<string, unknown>[] = [
    {
      id: SCANNER,
      org_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      name: 'ZA web builds',
      platform: 'freelancer',
      filters: { keywords: ['wordpress', 'shopify'] },
      poll_interval_seconds: 120,
      active: true,
      auto_send: false,
      min_score: null,
      daily_cap: 0,
      created_at: '2026-09-22T08:00:00Z',
      updated_at: '2026-09-22T08:00:00Z',
    },
  ];
  const role = options.role ?? 'owner';
  const toNumeric = (value: unknown) =>
    value === null || value === '' ? null : Number(value).toFixed(3);

  await signedIn(page);
  const requests = await serveApi(
    page,
    {
      'GET /v1/settings': (_request, route) =>
        route.fulfill({
          json: {
            settings,
            liveModeBlockers: blockersOf(settings),
            environmentLiveMode: options.environmentLiveMode ?? false,
            accounts: [account],
            telegramLinked: false,
            role,
          },
        }),
      'PATCH /v1/settings': (request, route) => {
        const body = request.body as Record<string, unknown>;
        if ('minMarginPct' in body) settings.minMarginPct = toNumeric(body.minMarginPct);
        if ('minMarginZarMinor' in body)
          settings.minMarginZarMinor =
            body.minMarginZarMinor === '' ? null : String(body.minMarginZarMinor);
        if ('fxBufferPct' in body) settings.fxBufferPct = toNumeric(body.fxBufferPct);
        if ('vatPct' in body) settings.vatPct = toNumeric(body.vatPct);
        if ('retentionDays' in body)
          settings.retentionDays = body.retentionDays === '' ? null : Number(body.retentionDays);
        if ('feeTable' in body) settings.feeTable = body.feeTable;
        return route.fulfill({ json: { settings, liveModeBlockers: blockersOf(settings) } });
      },
      'POST /v1/settings/live-mode': (request, route) => {
        const { live } = request.body as { live: boolean };
        const missing = blockersOf(settings);
        if (live && missing.length > 0) {
          return route.fulfill({
            status: 422,
            json: { error: `Live mode needs ${missing.join(', ')} before it can be switched on.` },
          });
        }
        settings.liveMode = live;
        return route.fulfill({ json: { settings, liveModeBlockers: missing } });
      },
      'PATCH /v1/platform-accounts/:id': (request, route) => {
        const body = request.body as {
          planName: string | null;
          monthlyBidAllowance: number | null;
        };
        account.planName = body.planName;
        account.monthlyBidAllowance = body.monthlyBidAllowance;
        account.planRecordedOn = '2026-09-22';
        return route.fulfill({ json: { account } });
      },
      'GET /v1/scanners': (_request, route) => route.fulfill({ json: { scanners } }),
      'POST /v1/scanners': (request, route) => {
        const body = request.body as Record<string, unknown>;
        const row = {
          id: crypto.randomUUID(),
          org_id: body.orgId,
          name: body.name,
          platform: body.platform,
          filters: body.filters,
          poll_interval_seconds: body.pollIntervalSeconds,
          active: body.active,
          auto_send: body.autoSend,
          min_score: body.minScore,
          daily_cap: body.dailyCap,
        };
        scanners.push(row);
        return route.fulfill({ status: 201, json: { scanner: row } });
      },
      'PATCH /v1/scanners/:id': (request, route) => {
        const body = request.body as Record<string, unknown>;
        const row = scanners.find((s) => request.path.endsWith(String(s.id)))!;
        Object.assign(row, {
          name: body.name,
          platform: body.platform,
          filters: body.filters,
          poll_interval_seconds: body.pollIntervalSeconds,
          active: body.active,
          auto_send: body.autoSend,
          min_score: body.minScore,
          daily_cap: body.dailyCap,
        });
        return route.fulfill({ json: { scanner: row } });
      },
      'DELETE /v1/scanners/:id': (request, route) => {
        const index = scanners.findIndex((s) => request.path.endsWith(String(s.id)));
        scanners.splice(index, 1);
        return route.fulfill({ status: 204 });
      },
      'POST /v1/telegram/link-codes': (_request, route) =>
        route.fulfill({
          status: 201,
          json: { code: 'ABCD2345', expiresAt: '2026-09-22T10:10:00Z' },
        }),
    },
    { role },
  );
  await page.goto('/settings.html');
  await expectStatus(page, 'Settings loaded.');
  return requests;
}

function posts(requests: Captured[], method: string, path: string | RegExp) {
  return requests.filter(
    (r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)),
  );
}

test('shows what is set and what still blocks live mode, from the API alone', async ({ page }) => {
  await open(page);
  await expect(page.locator('#env-live')).toHaveText('Off (LIVE_MODE=false)');
  await expect(page.locator('#live-badge')).toHaveText('Sandbox');
  const liveSwitch = page.getByRole('switch', { name: 'Organisation live mode' });
  await expect(liveSwitch).toBeDisabled();
  await expect(liveSwitch).toHaveAttribute('title', 'Set every rule above first.');
  await expect(page.locator('#live-blockers-list li')).toHaveCount(5);
  await expect(page.locator('#live-blockers-list li').first()).toHaveText(
    'minimum margin % (docs/02 D-02)',
  );
  await expect(page.getByLabel('Minimum margin (%)')).toHaveValue('');
  await expect(page.getByLabel('VAT (%)')).toHaveValue('15.000');
  await expect(page.locator('#fee-rows .fee-row')).toHaveCount(0);
  await expect(page.locator('#accounts')).toContainText('freelancer · ext-a');
  await expect(page.locator('#accounts')).toContainText('Plan not recorded yet (docs/02 T-03)');
  await expect(page.getByRole('button', { name: 'Connect Freelancer.com' })).toBeDisabled();
  await expect(page.locator('#connect-hint')).toContainText('B-03 and B-04');
  await expect(page.locator('#scanner-rows tr')).toHaveCount(1);
  await expect(page.locator('#scanner-rows tr').first()).toContainText('ZA web builds');
  // Nothing is being edited, so there is nothing to cancel: the button must not show.
  await expect(page.getByRole('button', { name: 'Cancel edit' })).toBeHidden();
  await expect(page.locator('#telegram-state')).toContainText('not linked yet');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('the environment switch is reported when it is on', async ({ page }) => {
  await open(page, { environmentLiveMode: true });
  await expect(page.locator('#env-live')).toHaveText('On (LIVE_MODE=true)');
});

test('margin rules are checked before they are sent, then saved as typed, and the blockers shrink', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('Minimum margin (%)').fill('-1');
  await page.getByLabel('Minimum margin (rand)').fill('abc');
  await page.getByRole('button', { name: 'Save margin rules' }).click();
  await expect(page.locator('#minMarginPct-error')).toHaveText('Must be zero or more.');
  await expect(page.locator('#minMarginZarMinor-error')).toHaveText('Must be a whole number.');
  await expect(page.getByLabel('Minimum margin (%)')).toBeFocused();
  expect(posts(requests, 'PATCH', '/v1/settings')).toHaveLength(0);

  await page.getByLabel('Minimum margin (%)').fill('25');
  await page.getByLabel('Minimum margin (rand)').fill('1 500,00');
  await page.getByLabel('FX buffer (%)').fill('3,5');
  await page.getByLabel('Retention (days)').fill('365');
  await page.getByRole('button', { name: 'Save margin rules' }).click();
  await expectStatus(page, 'Margin rules saved.');
  const patch = posts(requests, 'PATCH', '/v1/settings')[0];
  // R1 500,00 travels as 150 000 cents; the percentages as typed, with a decimal point.
  expect(patch?.body).toEqual({
    minMarginPct: '25',
    minMarginZarMinor: 150000,
    fxBufferPct: '3.5',
    vatPct: '15.000',
    retentionDays: '365',
  });
  await expect(page.getByLabel('Minimum margin (rand)')).toHaveValue('1500,00');
  await expect(page.getByLabel('Minimum margin (%)')).toHaveValue('25.000');
  await expect(page.locator('#live-blockers-list li')).toHaveCount(1);
  await expect(page.locator('#live-blockers-list li')).toHaveText(
    'at least one fee rule (docs/02 T-02)',
  );
});

test('a fee rule needs its source page and date; a full one saves, and can be removed again', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.locator('#fee-rows .fee-row')).toHaveCount(1);
  await expect(page.locator('#fee-0-platform')).toBeFocused();
  await page.getByRole('button', { name: 'Save fee table' }).click();
  await expect(page.locator('#fee-0-percent-error')).toHaveText('Must be a number from 0 to 100.');
  await expect(page.locator('#fee-0-source_url-error')).toHaveText(
    'Must be the URL of the official fee page.',
  );
  expect(posts(requests, 'PATCH', '/v1/settings')).toHaveLength(0);

  await page.locator('#fee-0-percent').fill('10');
  await page.locator('#fee-0-min_minor').fill('5,00');
  await page.locator('#fee-0-min_currency').fill('usd');
  await page.locator('#fee-0-source_url').fill('https://www.freelancer.com/feesandcharges');
  await page.locator('#fee-0-read_on').fill('2026-09-22');
  await page.getByRole('button', { name: 'Save fee table' }).click();
  await expectStatus(page, 'Fee table saved with 1 rule.');
  expect(posts(requests, 'PATCH', '/v1/settings')[0]?.body).toEqual({ feeTable: [FEE_RULE] });
  await expect(page.locator('#live-blockers-list li')).toHaveCount(4);

  await page.getByRole('button', { name: 'Remove fee rule 1' }).click();
  await expect(page.locator('#fee-rows .fee-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save fee table' }).click();
  await expectStatus(page, 'Fee table saved with 0 rules.');
  await expect(page.locator('#live-blockers-list li')).toHaveCount(5);
});

test('live mode asks for confirmation, cancelling leaves it off, confirming switches it and logs nothing here', async ({
  page,
}) => {
  const requests = await open(page, { complete: true });
  const liveSwitch = page.getByRole('switch', { name: 'Organisation live mode' });
  await expect(liveSwitch).toBeEnabled();
  await expect(page.locator('#live-blockers')).toBeHidden();

  await liveSwitch.click();
  await expect(page.getByRole('dialog')).toContainText('Switch live mode on?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(liveSwitch).not.toBeChecked();
  expect(posts(requests, 'POST', '/v1/settings/live-mode')).toHaveLength(0);

  await liveSwitch.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Go live' }).click();
  await expectStatus(page, 'Live mode is on for this organisation.');
  expect(posts(requests, 'POST', '/v1/settings/live-mode')[0]?.body).toEqual({ live: true });
  await expect(liveSwitch).toBeChecked();
  await expect(page.locator('#live-badge')).toHaveText('Live');

  await liveSwitch.click();
  await expect(page.getByRole('dialog')).toContainText('Switch live mode off?');
  await page.getByRole('dialog').getByRole('button', { name: 'Switch off' }).click();
  await expectStatus(page, 'Live mode is off. Nothing leaves.');
  await expect(liveSwitch).not.toBeChecked();
  expect(posts(requests, 'POST', '/v1/settings/live-mode')[1]?.body).toEqual({ live: false });
});

test('the plan and allowance are checked, saved and dated', async ({ page }) => {
  const requests = await open(page);
  await page.getByLabel('Monthly bid allowance').fill('1.5');
  await page.getByRole('button', { name: 'Save plan for freelancer' }).click();
  await expect(page.locator(`#${ACCOUNT}-monthlyBidAllowance-error`)).toHaveText(
    'Must be a whole number.',
  );
  expect(posts(requests, 'PATCH', /platform-accounts/)).toHaveLength(0);

  await page.getByLabel('Plan name').fill('Plus');
  await page.getByLabel('Monthly bid allowance').fill('100');
  await page.getByRole('button', { name: 'Save plan for freelancer' }).click();
  await expectStatus(page, 'Plan saved for freelancer.');
  const patch = posts(requests, 'PATCH', /platform-accounts/)[0];
  expect(patch?.path).toBe(`/v1/platform-accounts/${ACCOUNT}`);
  expect(patch?.body).toEqual({ planName: 'Plus', monthlyBidAllowance: 100 });
  await expect(page.locator('#accounts')).toContainText('Plan recorded 22/09/2026');
  await expect(page.getByLabel('Plan name')).toHaveValue('Plus');
});

test('a scanner is checked before it is sent: a name, and guardrails before auto-send', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Add scanner' }).click();
  await expect(page.locator('#scanner-name-error')).toHaveText('Must not be empty.');
  await page.getByLabel('Name', { exact: true }).fill('Auto bids');
  await page.getByRole('switch', { name: 'Auto-send' }).check();
  await page.getByRole('button', { name: 'Add scanner' }).click();
  await expect(page.locator('#scanner-dailyCap-error')).toHaveText(
    'Must be at least 1 before auto-send can be turned on.',
  );
  await expect(page.locator('#scanner-minScore-error')).toHaveText(
    'Must be set before auto-send can be turned on.',
  );
  expect(posts(requests, 'POST', '/v1/scanners')).toHaveLength(0);
});

test('a scanner can be added, edited and deleted, with delete confirmed', async ({ page }) => {
  const requests = await open(page);
  await page.getByLabel('Name', { exact: true }).fill('Shopify only');
  await page.getByLabel('Platform', { exact: true }).selectOption('upwork');
  await page.getByLabel('Keywords').fill('shopify, storefront');
  await page.getByLabel('Check every (seconds)').fill('300');
  await page.getByRole('button', { name: 'Add scanner' }).click();
  await expectStatus(page, 'Added “Shopify only”.');
  expect(posts(requests, 'POST', '/v1/scanners')[0]?.body).toEqual({
    orgId: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Shopify only',
    platform: 'upwork',
    filters: { keywords: ['shopify', 'storefront'] },
    pollIntervalSeconds: 300,
    active: true,
    autoSend: false,
    minScore: null,
    dailyCap: 0,
  });
  await expect(page.locator('#scanner-rows tr')).toHaveCount(2);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');

  await page.getByRole('button', { name: 'Edit ZA web builds' }).click();
  await expect(page.locator('#scanner-form-heading')).toHaveText('Edit “ZA web builds”');
  await expect(page.getByLabel('Keywords')).toHaveValue('wordpress, shopify');
  await page.getByRole('button', { name: 'Cancel edit' }).click();
  await expect(page.locator('#scanner-form-heading')).toHaveText('Add a scanner');

  await page.getByRole('button', { name: 'Edit ZA web builds' }).click();
  await page.getByLabel('Daily cap').fill('5');
  await page.getByLabel('Minimum score').fill('70');
  await page.getByRole('switch', { name: 'Auto-send' }).check();
  await page.getByRole('button', { name: 'Save scanner' }).click();
  await expectStatus(page, 'Saved “ZA web builds”.');
  const patch = posts(requests, 'PATCH', /\/v1\/scanners\//)[0];
  expect(patch?.path).toBe(`/v1/scanners/${SCANNER}`);
  expect(patch?.body).toMatchObject({ autoSend: true, dailyCap: 5, minScore: 70 });
  await expect(page.locator('#scanner-rows tr').first()).toContainText('On, cap 5/day, score ≥ 70');

  await page.getByRole('button', { name: 'Delete Shopify only' }).click();
  await expect(page.getByRole('dialog')).toContainText('Delete “Shopify only”?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(posts(requests, 'DELETE', /\/v1\/scanners\//)).toHaveLength(0);
  await page.getByRole('button', { name: 'Delete Shopify only' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expectStatus(page, 'Deleted “Shopify only”.');
  await expect(page.locator('#scanner-rows tr')).toHaveCount(1);
});

test('the API’s own refusal of a scanner lands on the field', async ({ page }) => {
  await signedIn(page);
  await serveApi(page, {
    'GET /v1/settings': (_request, route) =>
      route.fulfill({
        json: {
          settings: {
            minMarginPct: null,
            minMarginZarMinor: null,
            fxBufferPct: null,
            vatPct: '15.000',
            retentionDays: null,
            feeTable: [],
            liveMode: false,
            biddingPaused: false,
            updatedAt: null,
          },
          liveModeBlockers: [],
          environmentLiveMode: false,
          accounts: [],
          telegramLinked: true,
          role: 'owner',
        },
      }),
    'GET /v1/scanners': (_request, route) => route.fulfill({ json: { scanners: [] } }),
    'POST /v1/scanners': (_request, route) =>
      route.fulfill({
        status: 409,
        json: { error: 'a scanner with that name already exists in this org' },
      }),
  });
  await page.goto('/settings.html');
  await expectStatus(page, 'Settings loaded.');
  await expect(page.locator('#accounts')).toContainText('No platform account is connected.');
  await expect(page.locator('#telegram-state')).toContainText('is linked');
  await page.getByLabel('Name', { exact: true }).fill('Twice');
  await page.getByRole('button', { name: 'Add scanner' }).click();
  await expectStatus(
    page,
    'The API refused the request: a scanner with that name already exists in this org.',
  );
});

test('a Telegram link code is created and shown with its expiry', async ({ page }) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Create link code' }).click();
  await expectStatus(page, 'Link code created. It works once and expires in ten minutes.');
  expect(posts(requests, 'POST', '/v1/telegram/link-codes')).toHaveLength(1);
  await expect(page.locator('#link-code-out')).toHaveText(
    'Send /start ABCD2345 to the bot before 22/09/2026 12:10.',
  );
});

test('an operator can manage scanners and accounts but not the rules, fees or live mode', async ({
  page,
}) => {
  await open(page, { role: 'operator', complete: true });
  await expect(page.getByRole('switch', { name: 'Organisation live mode' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Organisation live mode' })).toHaveAttribute(
    'title',
    'Only an owner can switch live mode.',
  );
  await expect(page.getByRole('button', { name: 'Save margin rules' })).toBeDisabled();
  await expect(page.getByLabel('Minimum margin (%)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save fee table' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add rule' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add scanner' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save plan for freelancer' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Create link code' })).toBeEnabled();
});

test('a viewer can read everything and change nothing', async ({ page }) => {
  await open(page, { role: 'viewer' });
  for (const name of [
    'Save margin rules',
    'Save fee table',
    'Add rule',
    'Add scanner',
    'Save plan for freelancer',
    'Create link code',
    'Edit ZA web builds',
    'Delete ZA web builds',
  ]) {
    await expect(page.getByRole('button', { name })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Edit ZA web builds' })).toHaveAttribute(
    'title',
    'Your role can view scanners but not change them.',
  );
  await expect(page.getByRole('button', { name: 'Reload' })).toBeEnabled();
});

test('reload asks again', async ({ page }) => {
  const requests = await open(page);
  const before = requests.filter((r) => r.path === '/v1/settings').length;
  await page.getByRole('button', { name: 'Reload' }).click();
  await expectStatus(page, 'Settings loaded.');
  expect(requests.filter((r) => r.path === '/v1/settings').length).toBe(before + 1);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page, { complete: true });
  await expectNoSidewaysScroll(page);
});
