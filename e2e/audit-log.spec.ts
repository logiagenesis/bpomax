import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * ARB-062: "Filter by type/date/actor; export CSV", and every control on the page
 * (docs/05 section 1).
 *
 * The API is mocked at the network layer: there is no Supabase project to sign in to
 * (B-06), so no real session exists. The API side of the same contract — filters, org
 * scoping, CSV — is tested in apps/api/src/routes/events-export.test.ts.
 */
const ACTOR = '11111111-1111-4111-8111-111111111111';

function event(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `e-${n}`,
    org_id: 'org',
    actor_user_id: null,
    actor_kind: 'system',
    type: 'job.scored',
    subject_table: 'job_scores',
    subject_id: `abcdef12-0000-4000-8000-${String(n).padStart(12, '0')}`,
    request_id: null,
    outcome: 'ok',
    payload: {},
    // 21/09/2026 22:40 UTC is 22/09/2026 00:40 SAST.
    created_at: new Date(Date.UTC(2026, 8, 21, 22, 40) - n * 60_000).toISOString(),
    ...overrides,
  };
}

interface Mock {
  requests: URL[];
  status?: number;
  events?: (url: URL) => unknown[];
}

async function mockApi(page: Page, mock: Mock) {
  await page.route('**/v1/events/actors', (route) =>
    route.fulfill({
      json: { actors: [{ id: ACTOR, name: 'Owner One', email: 'owner@example.test' }] },
    }),
  );
  await page.route('**/v1/events.csv**', (route: Route) => {
    const url = new URL(route.request().url());
    mock.requests.push(url);
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="audit-log-20260922.csv"',
        'x-export-rows': '2',
        'x-export-truncated': url.searchParams.get('type') === 'job.ingested' ? 'true' : 'false',
      },
      body: 'date_sast,type\r\n22/09/2026 00:40,job.scored\r\n',
    });
  });
  await page.route(/\/v1\/events(\?.*)?$/, (route: Route) => {
    const url = new URL(route.request().url());
    mock.requests.push(url);
    if (mock.status && mock.status !== 200) {
      return route.fulfill({ status: mock.status, json: { error: 'unknown event type: x' } });
    }
    const events = mock.events ? mock.events(url) : [event(1)];
    return route.fulfill({ json: { events, page: { limit: 50, offset: 0 } } });
  });
}

const listRequests = (mock: Mock) => mock.requests.filter((u) => u.pathname === '/v1/events');
const lastList = (mock: Mock) => listRequests(mock).at(-1)!;

test('loads the log with dates in SAST, the outcome, the actor and the subject', async ({
  page,
}) => {
  const mock: Mock = {
    requests: [],
    events: () => [
      event(0, {
        actor_user_id: ACTOR,
        actor_kind: 'user',
        type: 'scanner.created',
        payload: { name: 'WordPress' },
      }),
      event(1, { outcome: 'error' }),
    ],
  };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');

  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('22/09/2026 00:40');
  await expect(rows.nth(0)).toContainText('scanner.created');
  await expect(rows.nth(0)).toContainText('Owner One');
  await expect(rows.nth(0)).toContainText('job_scores abcdef12');
  await expect(rows.nth(1)).toContainText('System');
  await expect(rows.nth(1).locator('.badge')).toHaveText('error');
  await expect(page.locator('#page-label')).toHaveText('Entries 1 to 2');
});

test('the details disclosure shows the payload', async ({ page }) => {
  const mock: Mock = { requests: [], events: () => [event(0, { payload: { name: 'WordPress' } })] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  const pre = page.locator('#rows pre');
  await expect(pre).toBeHidden();
  await page.getByText('Show', { exact: true }).click();
  await expect(pre).toBeVisible();
  await expect(pre).toContainText('"name": "WordPress"');
});

test('filters by type, actor and date, sending SAST days as UTC bounds', async ({ page }) => {
  const mock: Mock = { requests: [] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr')).toHaveCount(1);

  await page.getByLabel('Type').selectOption('proposal.submitted');
  await page.getByLabel('Actor').selectOption({ label: 'Owner One' });
  await page.getByLabel('From', { exact: true }).fill('01/09/2026');
  await page.getByLabel('To', { exact: true }).fill('22/09/2026');
  await page.getByRole('button', { name: 'Apply filters' }).click();

  await expect.poll(() => listRequests(mock).length).toBe(2);
  const params = lastList(mock).searchParams;
  expect(params.get('type')).toBe('proposal.submitted');
  expect(params.get('actor')).toBe(ACTOR);
  // 01/09 00:00 SAST is 31/08 22:00 UTC; "to 22/09" includes all of the 22nd.
  expect(params.get('from')).toBe('2026-08-31T22:00:00.000Z');
  expect(params.get('to')).toBe('2026-09-22T22:00:00.000Z');
  expect(params.get('offset')).toBe('0');
});

test('refuses a date it cannot read, without calling the API', async ({ page }) => {
  const mock: Mock = { requests: [] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr')).toHaveCount(1);

  await page.getByLabel('From', { exact: true }).fill('2026-09-01');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByLabel('From', { exact: true })).toBeFocused();
  await expect(page.getByLabel('From', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#filter-from-error')).toHaveText(
    'Enter the date as DD/MM/YYYY, for example 01/09/2026.',
  );
  await expect(page.locator('#status')).toHaveText(
    'A date needs fixing before the filters can be applied.',
  );

  await page.getByLabel('From', { exact: true }).fill('22/09/2026');
  await page.getByLabel('To', { exact: true }).fill('01/09/2026');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#filter-to-error')).toHaveText(
    'The end date must be on or after the start date.',
  );
  expect(listRequests(mock)).toHaveLength(1);
});

test('clear resets the filters and reloads the whole log', async ({ page }) => {
  const mock: Mock = { requests: [] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  await page.getByLabel('Type').selectOption('job.scored');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => listRequests(mock).length).toBe(2);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => listRequests(mock).length).toBe(3);
  expect(lastList(mock).searchParams.get('type')).toBeNull();
  await expect(page.getByLabel('Type')).toHaveValue('');
});

test('pages older and newer, fifty at a time', async ({ page }) => {
  const mock: Mock = {
    requests: [],
    events: (url) =>
      url.searchParams.get('offset') === '0'
        ? Array.from({ length: 50 }, (_, i) => event(i))
        : [event(50), event(51)],
  };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  const newer = page.getByRole('button', { name: 'Newer' });
  const older = page.getByRole('button', { name: 'Older' });

  await expect(page.locator('#rows tr')).toHaveCount(50);
  await expect(newer).toBeDisabled();
  await expect(older).toBeEnabled();

  await older.click();
  await expect(page.locator('#rows tr')).toHaveCount(2);
  expect(lastList(mock).searchParams.get('offset')).toBe('50');
  await expect(page.locator('#page-label')).toHaveText('Entries 51 to 52');
  await expect(older).toBeDisabled();
  await expect(newer).toBeEnabled();

  await newer.click();
  await expect(page.locator('#rows tr')).toHaveCount(50);
  expect(lastList(mock).searchParams.get('offset')).toBe('0');
});

test('exports the filtered log as a CSV file', async ({ page }) => {
  const mock: Mock = { requests: [] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  await page.getByLabel('Type').selectOption('job.scored');
  await page.getByRole('button', { name: 'Apply filters' }).click();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('audit-log-20260922.csv');
  const path = await download.path();
  expect(readFileSync(path, 'utf8')).toContain('22/09/2026 00:40,job.scored');

  const csvRequest = mock.requests.find((u) => u.pathname === '/v1/events.csv')!;
  expect(csvRequest.searchParams.get('type')).toBe('job.scored');
  expect(csvRequest.searchParams.get('offset')).toBeNull();
  await expect(page.locator('#status')).toHaveText('Exported 2 entries to audit-log-20260922.csv.');
});

test('says so when an export was cut off at the cap', async ({ page }) => {
  const mock: Mock = { requests: [] };
  await mockApi(page, mock);
  await page.goto('/audit-log.html');
  await page.getByLabel('Type').selectOption('job.ingested');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.locator('#status')).toContainText('Narrow the dates to export the rest.');
});

test('shows an empty state when nothing matches', async ({ page }) => {
  await mockApi(page, { requests: [], events: () => [] });
  await page.goto('/audit-log.html');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toContainText('No entries match these filters.');
});

test('explains a signed-out session and a server failure in words', async ({ page }) => {
  await mockApi(page, { requests: [], status: 401 });
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveText(
    'You are signed out. Sign in again, then reload this page.',
  );

  await page.unrouteAll();
  await mockApi(page, { requests: [], status: 500 });
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveText(
    'The server could not answer (HTTP 500). Try again in a minute.',
  );
  await expect(page.locator('#empty')).toBeHidden();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await mockApi(page, { requests: [], events: () => [event(0), event(1)] });
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr')).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('the links on the page go somewhere', async ({ page }) => {
  await mockApi(page, { requests: [] });
  await page.goto('/audit-log.html');
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(/audit-log\.html$/);
  await page.getByRole('link', { name: 'Arbitron' }).click();
  await expect(page.getByRole('heading', { name: 'Arbitron' })).toBeVisible();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
});
