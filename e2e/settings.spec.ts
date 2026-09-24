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
  bands?: Record<string, unknown>[];
  freelancer?: { configured: boolean; environment: string | null; reason: string | null };
  upwork?: { configured: boolean; environment: string | null; reason: string | null };
  autoReply?: Record<string, unknown> | null;
  usage?: Record<string, unknown>;
}

/** `GET /v1/usage` for the house org (ARB-410): counted, never limited. */
const HOUSE_USAGE = {
  plan: { kind: 'exempt' },
  period: { start: '2026-09-01', resetsOn: '2026-10-01' },
  metrics: [
    { metric: 'jobs_scored', label: 'Jobs scored', used: 12, limit: null, percent: null },
    { metric: 'bids_drafted', label: 'Bids drafted', used: 4, limit: null, percent: null },
    { metric: 'bids_submitted', label: 'Bids sent', used: 0, limit: null, percent: null },
  ],
};

/** Two bands as `GET /v1/price-bands` returns them: one seed figure, one observed. */
const BANDS = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000031',
    categorySlug: 'website-build',
    categoryName: 'Website build',
    currency: 'ZAR',
    p25Minor: '150000',
    p50Minor: '300000',
    p75Minor: '600000',
    sampleSize: 0,
    source: 'seed',
    sampledAt: '2026-09-20T08:00:00Z',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000032',
    categorySlug: 'seo',
    categoryName: 'SEO',
    currency: 'USD',
    p25Minor: '30000',
    p50Minor: '60000',
    p75Minor: '90000',
    sampleSize: 14,
    source: 'owner_csv',
    sampledAt: '2026-09-21T08:00:00Z',
  },
];

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
  let autoReply: Record<string, unknown> | null = options.autoReply ?? null;
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
            ...(options.freelancer ? { freelancer: options.freelancer } : {}),
            ...(options.upwork ? { upwork: options.upwork } : {}),
          },
        }),
      'GET /v1/auto-reply': (_request, route) => route.fulfill({ json: { autoReply } }),
      'PUT /v1/auto-reply': (request, route) => {
        const body = request.body as Record<string, unknown>;
        autoReply = {
          id: 'aaaaaaaa-0000-4000-8000-000000000026',
          body: String(body.body).trim(),
          active: body.active === true,
          offlineAfterMinutes: Number(body.offlineAfterMinutes),
          approvedBy: 'aaaaaaaa-0000-4000-8000-000000000002',
          updatedAt: '2026-09-22T10:00:00Z',
        };
        return route.fulfill({ json: { autoReply } });
      },
      'POST /v1/platform-accounts/upwork/connect': (_request, route) =>
        route.fulfill({
          status: 201,
          json: {
            authorizeUrl:
              'https://www.upwork.com/ab/account-security/oauth2/authorize?response_type=code&client_id=e2e&redirect_uri=x',
            expiresAt: '2026-09-22T10:10:00Z',
          },
        }),
      'POST /v1/platform-accounts/freelancer/connect': (_request, route) =>
        route.fulfill({
          status: 201,
          json: {
            authorizeUrl:
              'https://accounts.freelancer-sandbox.com/oauth/authorize?response_type=code&client_id=e2e',
            expiresAt: '2026-09-22T10:10:00Z',
          },
        }),
      'POST /v1/platform-accounts/:id/disconnect': (_request, route) => {
        account.status = 'disconnected';
        return route.fulfill({ json: { account } });
      },
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
      'GET /v1/price-bands': (_request, route) =>
        route.fulfill({ json: { categories: 22, bands: options.bands ?? [] } }),
      'GET /v1/usage': (_request, route) => route.fulfill({ json: options.usage ?? HOUSE_USAGE }),
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
    'GET /v1/auto-reply': (_request, route) => route.fulfill({ json: { autoReply: null } }),
    'GET /v1/scanners': (_request, route) => route.fulfill({ json: { scanners: [] } }),
    'GET /v1/price-bands': (_request, route) =>
      route.fulfill({ json: { categories: 22, bands: [] } }),
    'GET /v1/usage': (_request, route) => route.fulfill({ json: HOUSE_USAGE }),
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
  await expect(page.getByRole('button', { name: 'Save auto-reply' })).toBeEnabled();
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
    'Save auto-reply',
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

test('with no market price band the section says none is invented, and why', async ({ page }) => {
  await open(page);
  await expect(page.locator('#bands-table')).toBeHidden();
  await expect(page.locator('#bands-empty')).toBeVisible();
  await expect(page.locator('#bands-empty')).toContainText('None is invented');
  await expect(page.locator('#bands-empty')).toContainText('D-14');
  await expect(page.locator('#bands-categories')).toHaveText('22 service categories.');
});

test('seed bands are labelled Seed; observed bands are labelled by their source', async ({
  page,
}) => {
  await open(page, { bands: BANDS });
  await expect(page.locator('#bands-empty')).toBeHidden();
  const rows = page.locator('#bands-rows tr');
  await expect(rows).toHaveCount(2);
  const seed = rows.nth(0);
  await expect(seed.locator('td').nth(0)).toHaveText('Website build');
  // R1 500,00 / R3 000,00 / R6 000,00 with no-break spaces (D-024).
  await expect(seed.locator('td').nth(2)).toHaveText('R1\u00a0500,00');
  await expect(seed.locator('td').nth(3)).toHaveText('R3\u00a0000,00');
  await expect(seed.locator('td').nth(4)).toHaveText('R6\u00a0000,00');
  await expect(seed.locator('.badge--seed')).toHaveText('Seed');
  await expect(seed.locator('.badge--seed')).toHaveAttribute(
    'title',
    'Seed figure, not observed data',
  );
  await expect(seed.locator('td').nth(7)).toHaveText('20/09/2026');
  const observed = rows.nth(1);
  await expect(observed.locator('td').nth(3)).toHaveText('USD 600,00');
  await expect(observed.locator('.badge--seed')).toHaveCount(0);
  await expect(observed.locator('.badge')).toHaveText('Owner CSV');
  await expect(observed.locator('td').nth(5)).toHaveText('14');
});

test('Connect Freelancer.com is off, with the API’s reason, while it is not configured', async ({
  page,
}) => {
  await open(page, {
    freelancer: {
      configured: false,
      environment: null,
      reason: 'Freelancer.com is not configured: FREELANCER_CLIENT_ID is not set. (docs/02 B-03)',
    },
  });
  await expect(page.getByRole('button', { name: 'Connect Freelancer.com' })).toBeDisabled();
  await expect(page.locator('#connect-hint')).toHaveText(
    'Freelancer.com is not configured: FREELANCER_CLIENT_ID is not set. (docs/02 B-03)',
  );
});

test('Connect Freelancer.com asks the API and opens the sandbox authorise page it names', async ({
  page,
}) => {
  const requests = await open(page, {
    freelancer: { configured: true, environment: 'sandbox', reason: null },
  });
  await expect(page.locator('#connect-hint')).toHaveText(
    'Opens the Freelancer.com sandbox to sign in and approve access. One account per verified identity.',
  );
  await page.route('https://accounts.freelancer-sandbox.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Sandbox consent (stand-in)</h1>' }),
  );
  await page.getByRole('button', { name: 'Connect Freelancer.com' }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.freelancer-sandbox\.com\/oauth\/authorize\?/);
  expect(posts(requests, 'POST', '/v1/platform-accounts/freelancer/connect')).toHaveLength(1);
});

test('Connect Upwork is off, with the API’s reason, while there is no approved key', async ({
  page,
}) => {
  await open(page, {
    upwork: {
      configured: false,
      environment: null,
      reason: 'Upwork is not configured: UPWORK_CLIENT_ID is not set. (docs/02 B-14)',
    },
  });
  await expect(page.getByRole('button', { name: 'Connect Upwork' })).toBeDisabled();
  await expect(page.locator('#connect-upwork-hint')).toHaveText(
    'Upwork is not configured: UPWORK_CLIENT_ID is not set. (docs/02 B-14)',
  );
});

test('Connect Upwork asks the API and opens the Upwork authorise page it names, to read jobs only', async ({
  page,
}) => {
  const requests = await open(page, {
    upwork: { configured: true, environment: 'production', reason: null },
  });
  await expect(page.locator('#connect-upwork-hint')).toHaveText(
    'Opens Upwork to sign in and approve access, to read jobs only. One account per verified identity.',
  );
  await page.route('https://www.upwork.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Upwork consent (stand-in)</h1>' }),
  );
  await page.getByRole('button', { name: 'Connect Upwork' }).click();
  await expect(page).toHaveURL(
    /^https:\/\/www\.upwork\.com\/ab\/account-security\/oauth2\/authorize\?/,
  );
  expect(posts(requests, 'POST', '/v1/platform-accounts/upwork/connect')).toHaveLength(1);
});

test('a viewer sees Connect and Disconnect but cannot use them', async ({ page }) => {
  await open(page, {
    role: 'viewer',
    freelancer: { configured: true, environment: 'sandbox', reason: null },
  });
  await expect(page.getByRole('button', { name: 'Connect Freelancer.com' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disconnect freelancer' })).toBeDisabled();
});

test('Disconnect asks first; cancelling sends nothing; confirming disconnects the account', async ({
  page,
}) => {
  const requests = await open(page);
  const disconnect = page.getByRole('button', { name: 'Disconnect freelancer' });
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(posts(requests, 'POST', /\/disconnect$/)).toHaveLength(0);
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expectStatus(page, 'Disconnected freelancer.');
  expect(posts(requests, 'POST', /\/disconnect$/)).toHaveLength(1);
  await expect(page.locator('#accounts')).toContainText('Status disconnected');
  await expect(page.getByRole('button', { name: 'Disconnect freelancer' })).toHaveCount(0);
});

test('the auto-reply is checked before it is sent, then saved and shown as on', async ({
  page,
}) => {
  const requests = await open(page);
  await expect(page.locator('#auto-reply-state')).toHaveText('Not set up yet.');
  await page.getByLabel('Reply text').fill('  ');
  await page.getByLabel('Send after nobody has replied for (minutes)').fill('soon');
  await page.getByLabel('Auto-reply on').check();
  await page.getByRole('button', { name: 'Save auto-reply' }).click();
  await expect(page.locator('#autoReply-body-error')).toHaveText(
    'Must not be empty while the auto-reply is on.',
  );
  await expect(page.locator('#autoReply-offlineAfterMinutes-error')).toHaveText(
    'Must be a whole number of minutes.',
  );
  await expect(page.getByLabel('Reply text')).toBeFocused();
  expect(posts(requests, 'PUT', '/v1/auto-reply')).toHaveLength(0);

  await page.getByLabel('Reply text').fill('Thanks for your message. I will reply within a day.');
  await page.getByLabel('Send after nobody has replied for (minutes)').fill('20');
  await page.getByRole('button', { name: 'Save auto-reply' }).click();
  await expectStatus(page, 'Auto-reply saved.');
  expect(posts(requests, 'PUT', '/v1/auto-reply')[0]?.body).toEqual({
    body: 'Thanks for your message. I will reply within a day.',
    active: true,
    offlineAfterMinutes: '20',
  });
  await expect(page.locator('#auto-reply-state')).toHaveText(
    'On. Sent once per thread after 20 minutes without a reply.',
  );
});

test('a saved auto-reply is shown as it is, off or on', async ({ page }) => {
  await open(page, {
    autoReply: { id: 'x', body: 'Back soon.', active: false, offlineAfterMinutes: 45 },
  });
  await expect(page.getByLabel('Reply text')).toHaveValue('Back soon.');
  await expect(page.getByLabel('Send after nobody has replied for (minutes)')).toHaveValue('45');
  await expect(page.getByLabel('Auto-reply on')).not.toBeChecked();
  await expect(page.locator('#auto-reply-state')).toHaveText('Off. Nothing is sent automatically.');
});

test('reload asks again', async ({ page }) => {
  const requests = await open(page);
  const before = requests.filter((r) => r.path === '/v1/settings').length;
  await page.getByRole('button', { name: 'Reload' }).click();
  await expectStatus(page, 'Settings loaded.');
  expect(requests.filter((r) => r.path === '/v1/settings').length).toBe(before + 1);
  expect(requests.filter((r) => r.path === '/v1/price-bands').length).toBe(before + 1);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page, { complete: true, bands: BANDS });
  await expectNoSidewaysScroll(page);
});

test.describe('plan and usage (ARB-410)', () => {
  test('the house org is shown as counted, never limited', async ({ page }) => {
    await open(page);
    await expect(page.locator('#plan-state')).toHaveText(
      'This is the house organisation: every metered action is counted, and none is limited.',
    );
    await expect(page.locator('#usage-rows tr[data-metric="jobs_scored"] td')).toHaveText([
      'Jobs scored',
      '12',
      'No limit',
      '—',
    ]);
    await expect(page.locator('#usage-period')).toHaveText(
      'Counted from 01/09/2026, South African time; the counts start again on 01/10/2026.',
    );
  });

  test('a customer on a plan sees each count against its limit, flagged near and at it', async ({
    page,
  }) => {
    // A made-up plan for the test; no real plan exists (docs/02 D-12).
    await open(page, {
      usage: {
        plan: { kind: 'plan', code: 'test-plan', name: 'Test plan', status: 'past_due' },
        period: { start: '2026-09-01', resetsOn: '2026-10-01' },
        metrics: [
          { metric: 'jobs_scored', label: 'Jobs scored', used: 80, limit: 100, percent: 80 },
          { metric: 'bids_drafted', label: 'Bids drafted', used: 10, limit: 10, percent: 100 },
          { metric: 'bids_submitted', label: 'Bids sent', used: 3, limit: 50, percent: 6 },
        ],
      },
    });
    await expect(page.locator('#plan-state')).toHaveText('Plan: Test plan, payment overdue.');
    await expect(page.locator('#usage-rows tr[data-metric="jobs_scored"] td').nth(3)).toHaveText(
      '80% Near the limit',
    );
    await expect(page.locator('#usage-rows tr[data-metric="bids_drafted"] td').nth(3)).toHaveText(
      '100% Limit reached',
    );
    await expect(page.locator('#usage-rows tr[data-metric="bids_submitted"] td').nth(3)).toHaveText(
      '6%',
    );
  });

  test('links to the billing page (ARB-420)', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('link', { name: 'Choose or pay for the plan' })).toHaveAttribute(
      'href',
      './billing.html',
    );
  });

  test('a customer with no plan is told why nothing metered runs', async ({ page }) => {
    await open(page, {
      usage: {
        plan: {
          kind: 'none',
          reason: 'no_plans',
          message:
            'No plans are published yet, so metered actions are off for this organisation (docs/02 D-12).',
        },
        period: { start: '2026-09-01', resetsOn: '2026-10-01' },
        metrics: HOUSE_USAGE.metrics,
      },
    });
    await expect(page.locator('#plan-state')).toHaveText(
      'No plans are published yet, so metered actions are off for this organisation (docs/02 D-12).',
    );
    await expect(page.locator('#plan-state')).toHaveClass(/alert--warning/);
  });
});
