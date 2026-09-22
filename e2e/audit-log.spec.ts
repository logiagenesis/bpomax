import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * ARB-062 acceptance: filter by type, date and actor; export CSV.
 *
 * The API is mocked at the network edge with the exact shapes the three audit routes
 * return (apps/api/src/routes/events.ts, themselves tested against real Postgres in
 * server.test.ts and events-export.test.ts). That is the only seam a static front end
 * has; every control on the page is exercised through it.
 */
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

interface EventRow {
  id: string;
  org_id: string;
  actor_user_id: string | null;
  actor_kind: 'user' | 'system';
  type: string;
  subject_table: string | null;
  subject_id: string | null;
  request_id: string | null;
  outcome: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

function event(partial: Partial<EventRow> & { type: string; created_at: string }): EventRow {
  return {
    id: crypto.randomUUID(),
    org_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    actor_user_id: null,
    actor_kind: 'system',
    subject_table: null,
    subject_id: null,
    request_id: null,
    outcome: 'ok',
    payload: {},
    ...partial,
  };
}

const FIXTURES: EventRow[] = [
  event({
    type: 'proposal.approved',
    created_at: '2026-09-22T12:05:00Z',
    actor_kind: 'user',
    actor_user_id: USER_A,
    subject_table: 'proposals',
    subject_id: 'cccccccc-0000-4000-8000-000000000020',
    payload: { amount_minor: 250000, currency: 'USD' },
  }),
  event({
    type: 'scanner.created',
    created_at: '2026-09-21T22:30:00Z', // 22/09 00:30 SAST
    actor_kind: 'user',
    actor_user_id: USER_B,
    subject_table: 'scanners',
    payload: { name: 'ZA web builds, "urgent"' },
  }),
  event({
    type: 'external.blocked_by_live_mode',
    created_at: '2026-09-20T09:00:00Z',
    outcome: 'blocked',
    payload: { endpoint: '=POST /projects/0.1/bids' },
  }),
  event({ type: 'job.ingested', created_at: '2026-09-19T08:00:00Z' }),
];

/** What GET /v1/events/actors returns for these fixtures: one named, one email-only. */
const ACTORS = [
  { id: USER_A, name: 'Ayanda Nkosi', email: 'ayanda@example.com' },
  { id: USER_B, name: null, email: 'b@example.com' },
];

/** The body GET /v1/events.csv would serve for the "blocked" filter; its format is the API's own test. */
const CSV_BODY =
  'date_sast,created_at_utc,type,outcome,actor_kind,actor_user_id,subject_table,subject_id,request_id,payload,id\r\n' +
  '20/09/2026 11:00,2026-09-20T09:00:00.000Z,external.blocked_by_live_mode,blocked,system,,,,,"{""endpoint"":""=POST /projects/0.1/bids""}",' +
  `${FIXTURES[2]?.id ?? ''}\r\n`;

function matching(url: URL): EventRow[] {
  const type = url.searchParams.get('type');
  const actor = url.searchParams.get('actor');
  const outcome = url.searchParams.get('outcome');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  return FIXTURES.filter(
    (e) =>
      (!type || type.split(',').includes(e.type)) &&
      (!actor || e.actor_user_id === actor) &&
      (!outcome || e.outcome === outcome) &&
      (!from || e.created_at >= from) &&
      (!to || e.created_at < to),
  );
}

interface ApiOptions {
  actors?: { status: number; body: unknown };
  exportTruncated?: boolean;
}

/** Serves the three audit routes the way the API would, honouring the filters the page sends. */
async function serveApi(route: Route, requests: URL[], options: ApiOptions = {}) {
  const url = new URL(route.request().url());
  requests.push(url);

  if (url.pathname.endsWith('/v1/events/actors')) {
    const actors = options.actors ?? { status: 200, body: { actors: ACTORS } };
    await route.fulfill({ status: actors.status, json: actors.body });
    return;
  }

  if (url.pathname.endsWith('/v1/events.csv')) {
    const rows = matching(url);
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="audit-log-20260922.csv"',
        'x-export-rows': String(rows.length),
        'x-export-truncated': String(options.exportTruncated ?? false),
        // The API exposes these three (server.ts); without this a browser hides them from
        // a page on another origin, and the export would report 0 rows.
        'access-control-expose-headers': 'content-disposition, x-export-rows, x-export-truncated',
      },
      body: CSV_BODY,
    });
    return;
  }

  const limit = Number(url.searchParams.get('limit') ?? 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const rows = matching(url).slice(offset, offset + limit);
  await route.fulfill({ json: { events: rows, page: { limit, offset } } });
}

async function openWithApi(page: Page, options: ApiOptions = {}): Promise<URL[]> {
  const requests: URL[] = [];
  await page.route('**/v1/events**', (route) => serveApi(route, requests, options));
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveText('Loaded 4 events.');
  return requests;
}

test('lists events newest first, formatted the one way the app allows', async ({ page }) => {
  await openWithApi(page);
  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('22/09/2026 14:05');
  await expect(rows.nth(0)).toContainText('proposal.approved');
  // Actors are shown by name when the API knows one, by email otherwise.
  await expect(rows.nth(0)).toContainText('Ayanda Nkosi');
  await expect(rows.nth(1)).toContainText('b@example.com');
  await expect(rows.nth(0)).toContainText('proposals cccccccc');
  // 22:30 UTC on the 21st is 00:30 on the 22nd in Johannesburg.
  await expect(rows.nth(1)).toContainText('22/09/2026 00:30');
  await expect(rows.nth(3)).toContainText('System');
  await expect(page.locator('#count')).toHaveText('Showing 1–4');
});

test('filters by type, and sends the API exactly that type', async ({ page }) => {
  const requests = await openWithApi(page);
  await page.getByLabel('Type', { exact: true }).selectOption('scanner.created');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#status')).toHaveText('Loaded 1 event.');
  await expect(page.locator('#rows tr')).toHaveCount(1);
  await expect(page.locator('#rows')).toContainText('scanner.created');
  expect(requests.at(-1)?.searchParams.get('type')).toBe('scanner.created');
  await expect(page).toHaveURL(/type=scanner\.created/);
});

test('filters by date as whole South African days', async ({ page }) => {
  const requests = await openWithApi(page);
  await page.getByLabel('From', { exact: true }).fill('2026-09-22');
  await page.getByLabel('To', { exact: true }).fill('2026-09-22');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#status')).toHaveText('Loaded 2 events.');
  // 00:00 SAST on the 22nd is 22:00 UTC on the 21st; the upper bound is the next midnight.
  expect(requests.at(-1)?.searchParams.get('from')).toBe('2026-09-21T22:00:00.000Z');
  expect(requests.at(-1)?.searchParams.get('to')).toBe('2026-09-22T22:00:00.000Z');
});

test('offers the people in the log, and filters by one of them', async ({ page }) => {
  const requests = await openWithApi(page);
  const actor = page.getByLabel('Actor', { exact: true });
  await expect(actor.locator('option')).toHaveText([
    'Everyone',
    'Ayanda Nkosi (ayanda@example.com)',
    'b@example.com',
  ]);
  await actor.selectOption(USER_B);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#rows tr')).toHaveCount(1);
  await expect(page.locator('#rows')).toContainText('scanner.created');
  expect(requests.at(-1)?.searchParams.get('actor')).toBe(USER_B);
  await expect(page).toHaveURL(new RegExp(`actor=${USER_B}`));
});

test('still loads the log when the people list fails', async ({ page }) => {
  await openWithApi(page, { actors: { status: 500, body: { error: 'boom' } } });
  await expect(page.getByLabel('Actor', { exact: true }).locator('option')).toHaveText([
    'Everyone',
  ]);
  // With no name to show, the actor column falls back to the start of the id.
  await expect(page.locator('#rows tr').nth(0)).toContainText(USER_A.slice(0, 8));
});

test('filters by outcome', async ({ page }) => {
  await openWithApi(page);
  await page.getByLabel('Outcome', { exact: true }).selectOption('blocked');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#rows tr')).toHaveCount(1);
  await expect(page.locator('#rows .badge--caution')).toHaveText('blocked');
});

test('refuses a bad filter and says which field', async ({ page }) => {
  const requests = await openWithApi(page);
  const before = requests.length;
  await page.getByLabel('From', { exact: true }).fill('2026-09-22');
  await page.getByLabel('To', { exact: true }).fill('2026-09-01');
  await page.getByRole('button', { name: 'Apply filters' }).click();

  await expect(page.locator('#status')).toHaveText(/Some fields need attention/);
  await expect(page.locator('#to-error')).toHaveText('Must not be before the From date.');
  await expect(page.getByLabel('To', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('To', { exact: true })).toBeFocused();
  // Nothing was sent to the API for a filter the page itself refused.
  expect(requests.length).toBe(before);
});

test('clear puts everything back', async ({ page }) => {
  await openWithApi(page);
  await page.getByLabel('Type', { exact: true }).selectOption('job.ingested');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#rows tr')).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('#rows tr')).toHaveCount(4);
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('');
  await expect(page).not.toHaveURL(/type=/);
});

test('a linked view restores its filters', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/v1/events**', (route) => serveApi(route, requests));
  await page.goto(`/audit-log.html?type=scanner.created&actor=${USER_B}`);
  await expect(page.locator('#status')).toHaveText('Loaded 1 event.');
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('scanner.created');
  await expect(page.getByLabel('Actor', { exact: true })).toHaveValue(USER_B);
  expect(requests.at(-1)?.searchParams.get('actor')).toBe(USER_B);
});

test('shows an empty state when nothing matches', async ({ page }) => {
  await openWithApi(page);
  await page.getByLabel('From', { exact: true }).fill('2026-01-01');
  await page.getByLabel('To', { exact: true }).fill('2026-01-31');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#results')).toBeHidden();
  await expect(page.locator('#status')).toHaveText('No events match these filters.');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
});

test('pages through results', async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) =>
    event({
      type: 'job.ingested',
      created_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`,
    }),
  );
  const requests: URL[] = [];
  await page.route('**/v1/events**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/actors')) {
      await route.fulfill({ json: { actors: [] } });
      return;
    }
    requests.push(url);
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    await route.fulfill({
      json: { events: many.slice(offset, offset + limit), page: { limit, offset } },
    });
  });
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveText('Loaded 25 events.');
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#status')).toHaveText('Loaded 5 events.');
  await expect(page.locator('#count')).toHaveText('Showing 26–30');
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(requests.at(-1)?.searchParams.get('offset')).toBe('25');

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('#count')).toHaveText('Showing 1–25');
});

test('exports the filtered log as the CSV file the API serves', async ({ page }) => {
  const requests = await openWithApi(page);
  await page.getByLabel('Outcome', { exact: true }).selectOption('blocked');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#rows tr')).toHaveCount(1);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  // The file is named by the API, and the request carries the filter but no paging.
  expect(download.suggestedFilename()).toBe('audit-log-20260922.csv');
  const exportRequest = requests.at(-1);
  expect(exportRequest?.pathname).toMatch(/\/v1\/events\.csv$/);
  expect(exportRequest?.searchParams.get('outcome')).toBe('blocked');
  expect(exportRequest?.searchParams.has('limit')).toBe(false);
  expect(exportRequest?.searchParams.has('offset')).toBe(false);
  await expect(page.locator('#status')).toHaveText('Exported 1 event.');

  const { readFileSync } = await import('node:fs');
  expect(readFileSync(await download.path(), 'utf8')).toBe(CSV_BODY);
});

test('says when an export hit the cap', async ({ page }) => {
  await openWithApi(page, { exportTruncated: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await downloadPromise;
  await expect(page.locator('#status')).toHaveText(
    'Exported the first 4 matching events. Narrow the filter for the rest.',
  );
});

test('says so plainly when there is no session', async ({ page }) => {
  await page.route('**/v1/events**', (route) =>
    route.fulfill({ status: 401, json: { error: 'not signed in' } }),
  );
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
  await expect(page.locator('#status')).toHaveText('Not signed in. Sign in and try again.');
  await expect(page.getByRole('button', { name: 'Apply filters' })).toBeEnabled();
});

test('says so plainly when the API is unreachable', async ({ page }) => {
  await page.route('**/v1/events**', (route) => route.abort('connectionrefused'));
  await page.goto('/audit-log.html');
  await expect(page.locator('#status')).toHaveText(/Could not reach the API/);
});

test('offers every event type the system can write', async ({ page }) => {
  await openWithApi(page);
  const options = page.getByLabel('Type', { exact: true }).locator('option');
  expect(await options.count()).toBeGreaterThan(30);
  await expect(options.first()).toHaveText('All types');
  await expect(
    page.getByLabel('Type', { exact: true }).locator('option[value="retention.purged"]'),
  ).toHaveCount(1);
});

test('every link goes somewhere', async ({ page }) => {
  await openWithApi(page);
  await expect(page.getByRole('link', { name: 'Audit log' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: 'Style guide' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Style guide' })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'Arbitron' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Arbitron' })).toBeVisible();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openWithApi(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
