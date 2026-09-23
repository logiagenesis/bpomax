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
 * GET /v1/sourcing-requests, GET /v1/sourcing-requests/:id,
 * PATCH /v1/sourcing-requests/:id/candidates/:candidateId and its /reprice (ARB-204). The
 * scores are the ones hand-worked in packages/core/src/sourcing.test.ts.
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

/** A post as the API describes one (routes/sourcing-posts.ts). */
function post(partial: Record<string, unknown>) {
  return {
    id: 'p-freelancer',
    sourcingRequestId: REQUEST,
    platform: 'freelancer',
    manual: false,
    title: 'Shopify: An online shop that takes orders',
    body: 'An online shop that takes orders\n\nMust have:\n- Checkout\n\nPlease quote a fixed price and a turnaround in days.',
    budgetMinMinor: null,
    budgetMaxMinor: null,
    currency: null,
    status: 'draft',
    approvedBy: null,
    approvedByName: null,
    approvedVia: null,
    externalId: null,
    postedAt: null,
    createdAt: '2026-09-23T12:00:00Z',
    updatedAt: '2026-09-23T12:00:00Z',
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
  /** Posts already on the request (ARB-202). */
  posts?: Record<string, unknown>[];
  /** The API's answer to a post edit, in place of the stand-in's own. */
  postEdit?: { status: number; json: unknown };
  /** A candidate's margin and last reprice, by candidate id (ARB-204). */
  margins?: Record<string, { margin: unknown; reprice: unknown }>;
  /** The API's answer to Reprice, in place of the stand-in's own. */
  reprice?: { status: number; json: unknown };
}

/** What the reprice worker leaves for Thandi Web's R9 000,00 against a R10 300,00 budget. */
const THANDI_PRICED = {
  margin: {
    evaluationId: 'e1',
    currency: 'ZAR',
    marginMinor: '30000',
    marginPct: '2.913',
    passed: false,
    reason: 'margin 2.913% is below the 20.000% minimum',
    at: '2026-09-23T12:40:00Z',
  },
  reprice: { outcome: 'ok', reason: null, message: null, detail: [], at: '2026-09-23T12:40:00Z' },
};

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  let shortlisted: string[] = [];
  const posts = [...(options.posts ?? [])];
  const margins = { ...(options.margins ?? {}) };
  const current = () => {
    const r = request(shortlisted, options.partial ?? {});
    return {
      ...r,
      candidates: r.candidates.map((c) => ({ ...c, ...(margins[c.id] ?? {}) })),
    };
  };
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
      'GET /v1/sourcing-requests/:id/posts': (_req, route) => route.fulfill({ json: { posts } }),
      'POST /v1/sourcing-requests/:id/posts': (req, route) => {
        const platform = (req.body as { platform: string }).platform;
        const row = post({ id: `p-${platform}`, platform, manual: platform !== 'freelancer' });
        posts.push(row);
        return route.fulfill({ status: 201, json: { post: row } });
      },
      'PATCH /v1/sourcing-posts/:id': (req, route) => {
        if (options.postEdit) return route.fulfill(options.postEdit);
        const row = posts.find((p) => p.id === req.path.split('/').pop());
        const b = req.body as Record<string, unknown>;
        Object.assign(row ?? {}, {
          title: b.title,
          body: b.body,
          currency: b.currency,
          budgetMinMinor: b.budgetMinMinor === null ? null : String(b.budgetMinMinor),
          budgetMaxMinor: b.budgetMaxMinor === null ? null : String(b.budgetMaxMinor),
          status: 'draft',
          approvedByName: null,
          approvedVia: null,
        });
        return route.fulfill({ json: { post: row } });
      },
      'POST /v1/sourcing-posts/:id/:action': (req, route) => {
        const parts = req.path.split('/');
        const action = parts.pop();
        const postId = parts.pop();
        const row = posts.find((p) => p.id === postId);
        if (!row) return route.fulfill({ status: 404, json: { error: 'no such sourcing post' } });
        if (action === 'approve')
          Object.assign(row, {
            status: 'approved',
            approvedByName: 'Ayanda Nkosi',
            approvedVia: 'web',
          });
        if (action === 'posted')
          Object.assign(row, { status: 'posted', postedAt: '2026-09-23T12:30:00Z' });
        if (action === 'close') Object.assign(row, { status: 'closed' });
        if (action === 'collect') return route.fulfill({ status: 202, json: { queued: true } });
        return route.fulfill({ json: { post: row, queued: false } });
      },
      'POST /v1/sourcing-requests/:id/candidates/:candidateId/choose': (_req, route) =>
        route.fulfill({
          status: 201,
          json: { order: { id: 'aaaaaaaa-0000-4000-8000-000000000093', status: 'draft' } },
        }),
      'POST /v1/sourcing-requests/:id/candidates/:candidateId/reprice': (req, route) => {
        if (options.reprice) return route.fulfill(options.reprice);
        const candidate = req.path.split('/').at(-2) ?? '';
        if (candidate === THANDI) margins[THANDI] = THANDI_PRICED;
        return route.fulfill({ status: 202, json: { queued: true } });
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

test('Reprice asks the API for the candidate’s quote, then shows the margin it gives against the rule', async ({
  page,
}) => {
  const requests = await openRequest(page);
  const row = page.locator(`#candidate-rows tr[data-id="${THANDI}"]`);
  await expect(row).toContainText('Not priced yet');
  await page.getByRole('button', { name: 'Reprice the bid with Thandi Web’s quote' }).click();
  await expect(page.locator('#request-status')).toHaveText(
    'Asked for the bid to be priced with Thandi Web’s quote. The margin shows in the row once the worker has run; reopen the request to see it.',
  );
  const asked = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reprice'));
  expect(asked.map((r) => r.path)).toEqual([
    `/v1/sourcing-requests/${REQUEST}/candidates/${THANDI}/reprice`,
  ]);
  // Hand-worked in THANDI_PRICED: R300,00 is 2,9% of the budget, below the rule.
  const figure = row.locator('[data-margin]');
  await expect(figure).toHaveText('R300,00 (2,9%)');
  await expect(figure).toHaveAttribute('data-margin', 'bad');
  await expect(row).toContainText('Below the margin rule.');
});

test('a reprice blocked by an unanswered rule says which rule, and invents no figure', async ({
  page,
}) => {
  await openRequest(page, {
    margins: {
      [NORD]: {
        margin: null,
        reprice: {
          outcome: 'blocked',
          reason: 'rules_missing',
          message: null,
          detail: ['min_margin_pct (docs/02 D-02)', 'fee_table (docs/02 T-02)'],
          at: '2026-09-23T12:40:00Z',
        },
      },
    },
  });
  const row = page.locator(`#candidate-rows tr[data-id="${NORD}"]`);
  await expect(row.locator('[data-margin]')).toHaveText('Not priced: a margin rule is not set');
  await expect(row).toContainText('min_margin_pct (docs/02 D-02); fee_table (docs/02 T-02)');
  await expect(row).not.toContainText('%)');
});

test('the API’s refusal to reprice is shown as it is', async ({ page }) => {
  await openRequest(page, {
    reprice: {
      status: 503,
      json: {
        error:
          'The workers are not running here, so the quote cannot be priced now (docs/02 B-12).',
      },
    },
  });
  await page.getByRole('button', { name: 'Reprice the bid with Studio Nord’s quote' }).click();
  await expect(page.locator('#request-status')).toHaveText(
    'The workers are not running here, so the quote cannot be priced now (docs/02 B-12).',
  );
});

test('Reprice is closed to a viewer, with the reason', async ({ page }) => {
  await openRequest(page, { role: 'viewer' });
  const button = page.getByRole('button', { name: 'Reprice the bid with Thandi Web’s quote' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'Your role can view sourcing but not change it.');
});

test('Reprice is closed to a candidate with no quote, with the reason', async ({ page }) => {
  const noQuote = candidates().map((c) => (c.id === NORD ? { ...c, quotedPriceMinor: null } : c));
  await serve(page, { partial: { candidates: noQuote } });
  await page.goto(`/sourcing.html?request=${REQUEST}`);
  const closed = page.getByRole('button', { name: 'Reprice the bid with Studio Nord’s quote' });
  await expect(closed).toBeDisabled();
  await expect(closed).toHaveAttribute(
    'title',
    'This candidate has no quote yet, so there is nothing to reprice with.',
  );
});

test('Choose asks first, opens a delivery order at the quote, and links to it on the pipeline page', async ({
  page,
}) => {
  const requests = await openRequest(page);
  await page.getByRole('button', { name: 'Choose Thandi Web as the supplier' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Choose Thandi Web?');
  await expect(dialog).toContainText('their quote of R9 000,00 fixed');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: 'Choose Thandi Web as the supplier' }).click();
  await dialog.getByRole('button', { name: 'Choose' }).click();
  await expect(page.locator('#request-status')).toContainText(
    'Chose Thandi Web. The delivery order is open on the pipeline page.',
  );
  await expect(page.getByRole('link', { name: 'Open the delivery order' })).toHaveAttribute(
    'href',
    'pipeline.html?order=aaaaaaaa-0000-4000-8000-000000000093',
  );
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
    `/v1/sourcing-requests/${REQUEST}/candidates/${THANDI}/choose`,
  ]);
});

test('Choose is closed to a viewer, a candidate with no quote, and a request with a supplier chosen', async ({
  page,
}) => {
  await openRequest(page, { role: 'viewer' });
  await expect(
    page.getByRole('button', { name: 'Choose Thandi Web as the supplier' }),
  ).toHaveAttribute('title', 'Your role can view sourcing but not change it.');
  const noQuote = candidates().map((c) => (c.id === NORD ? { ...c, quotedPriceMinor: null } : c));
  await serve(page, { partial: { candidates: noQuote } });
  await page.goto(`/sourcing.html?request=${REQUEST}`);
  await expect(
    page.getByRole('button', { name: 'Choose Studio Nord as the supplier' }),
  ).toHaveAttribute('title', 'This candidate has no quote yet, so there is no cost to agree.');
  await serve(page, { partial: { status: 'chosen' } });
  await page.goto(`/sourcing.html?request=${REQUEST}`);
  const closed = page.getByRole('button', { name: 'Choose Thandi Web as the supplier' });
  await expect(closed).toBeDisabled();
  await expect(closed).toHaveAttribute(
    'title',
    'This request is supplier chosen, so a supplier cannot be chosen on it.',
  );
});

test('Draft a post writes the brief’s scope for the chosen platform, with no budget', async ({
  page,
}) => {
  const requests = await openRequest(page);
  await expect(page.locator('#posts-empty')).toBeVisible();
  await page.getByLabel('Platform').selectOption('freelancer');
  await page.getByRole('button', { name: 'Draft a post' }).click();
  await expect(page.locator('#posts-status')).toHaveText(
    'Drafted the Freelancer.com post from the brief’s scope. Read it, edit it, then approve it.',
  );
  expect(requests.find((r) => r.method === 'POST' && r.path.endsWith('/posts'))).toMatchObject({
    path: `/v1/sourcing-requests/${REQUEST}/posts`,
    body: { platform: 'freelancer' },
  });
  const card = page.locator('#posts article');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Freelancer.com post');
  await expect(card).toContainText('Draft');
  await expect(card).toContainText('Shopify: An online shop that takes orders');
  await expect(card).toContainText('Budget: No budget named');
  await expect(
    page.getByRole('button', { name: 'Record the Freelancer.com post as posted by hand' }),
  ).toHaveCount(0);
});

test('an edit that names the client is refused on the page, and nothing is sent', async ({
  page,
}) => {
  const requests = await openRequest(page, { posts: [post({})] });
  await page.getByRole('button', { name: 'Edit the Freelancer.com post' }).click();
  await page.getByLabel('Post title').fill('Rebuild for acme-shop');
  await page.getByLabel('Post text').fill('Scope. Write to buyer@example.org');
  await page.getByRole('button', { name: 'Save the Freelancer.com post' }).click();
  await expect(page.locator('#post-p-freelancer-title-error')).toHaveText(
    'Contains the client’s handle.',
  );
  await expect(page.locator('#post-p-freelancer-body-error')).toHaveText(
    'Contains an email address.',
  );
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
});

test('Save post sends the budget as whole cents and shows it in the one money format', async ({
  page,
}) => {
  const requests = await openRequest(page, { posts: [post({})] });
  await page.getByRole('button', { name: 'Edit the Freelancer.com post' }).click();
  await page.getByLabel('Budget currency').fill('zar');
  await page.getByLabel('Budget from').fill('8 000,00');
  await page.getByLabel('Budget to').fill('12000');
  await page.getByRole('button', { name: 'Save the Freelancer.com post' }).click();
  await expect(page.locator('#posts-status')).toHaveText('Saved the Freelancer.com post.');
  // Hand-worked: R8 000,00 is 800 000 cents; R12 000 is 1 200 000 cents.
  expect(requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({
    currency: 'ZAR',
    budgetMinMinor: 800000,
    budgetMaxMinor: 1200000,
  });
  await expect(page.locator('#posts article')).toContainText('Budget: R8 000,00 – R12 000,00');
});

test('the API’s identity check lands on the fields with its own sentence', async ({ page }) => {
  await openRequest(page, {
    posts: [post({})],
    postEdit: {
      status: 422,
      json: {
        error: 'The post could identify the client. Take out what is named and save again.',
        errors: [{ field: 'body', message: 'contains the name of the client’s sign-off person' }],
      },
    },
  });
  await page.getByRole('button', { name: 'Edit the Freelancer.com post' }).click();
  await page.getByLabel('Post text').fill('Thandi signs off');
  await page.getByRole('button', { name: 'Save the Freelancer.com post' }).click();
  await expect(page.locator('#posts-status')).toHaveText(
    'The post could identify the client. Take out what is named and save again.',
  );
  await expect(page.locator('#post-p-freelancer-body-error')).toHaveText(
    'Contains the name of the client’s sign-off person.',
  );
});

test('Cancel leaves the post as it was', async ({ page }) => {
  const requests = await openRequest(page, { posts: [post({})] });
  await page.getByRole('button', { name: 'Edit the Freelancer.com post' }).click();
  await page.getByLabel('Post title').fill('Changed');
  await page.getByRole('button', { name: 'Cancel editing the Freelancer.com post' }).click();
  await expect(page.getByRole('button', { name: 'Edit the Freelancer.com post' })).toBeVisible();
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
});

test('Approve asks first, then approves in the person’s name; it cannot be approved twice', async ({
  page,
}) => {
  const requests = await openRequest(page, {
    posts: [post({ currency: 'ZAR', budgetMinMinor: '800000', budgetMaxMinor: '1200000' })],
  });
  await page.getByRole('button', { name: 'Approve the Freelancer.com post' }).click();
  await expect(page.getByRole('dialog')).toContainText('Approve the Freelancer.com post?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.path.endsWith('/approve'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve the Freelancer.com post' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#posts-status')).toHaveText(
    'Approved the Freelancer.com post. It is posted when live mode allows; until then the audit log shows what would be sent.',
  );
  await expect(page.locator('#posts article')).toContainText('approved by Ayanda Nkosi via web');
  const approve = page.getByRole('button', { name: 'Approve the Freelancer.com post' });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute(
    'title',
    'This post is approved, so it cannot be approved.',
  );
});

test('a Freelancer.com post without a budget cannot be approved, and says why', async ({
  page,
}) => {
  await openRequest(page, { posts: [post({})] });
  const approve = page.getByRole('button', { name: 'Approve the Freelancer.com post' });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute(
    'title',
    'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
  );
});

test('a failed post shows why; a posted one shows its project and collects its bids on request', async ({
  page,
}) => {
  const requests = await openRequest(page, {
    posts: [
      post({
        id: 'p-failed',
        status: 'failed',
        failureReason: 'Freelancer.com lists no currency EUR, so the project is not posted.',
      }),
      post({
        id: 'p-posted',
        status: 'posted',
        externalId: '16000001',
        postedAt: '2026-09-23T12:30:00Z',
        currency: 'ZAR',
        budgetMinMinor: '800000',
        budgetMaxMinor: '1200000',
      }),
    ],
  });
  const cards = page.locator('#posts article');
  await expect(cards.nth(0)).toContainText(
    'Not posted: Freelancer.com lists no currency EUR, so the project is not posted.',
  );
  await expect(cards.nth(1)).toContainText('Freelancer.com project 16000001');
  await page
    .getByRole('button', { name: 'Collect the bids on the Freelancer.com post now' })
    .click();
  await expect(page.locator('#posts-status')).toHaveText(
    'Asked Freelancer.com for the bids on the Freelancer.com post. They appear in the ranking as they arrive.',
  );
  expect(requests.find((r) => r.path.endsWith('/collect'))?.path).toBe(
    '/v1/sourcing-posts/p-posted/collect',
  );
});

test('a bid collected from the platform appears in the ranking with where it came from', async ({
  page,
}) => {
  await serve(page, {
    partial: {
      candidates: [
        ...candidates(),
        {
          id: 'c-bid',
          supplierId: null,
          name: 'kolkata-devs',
          channel: null,
          countryCode: 'IN',
          timeZone: null,
          currency: 'ZAR',
          quotedPriceMinor: '750000',
          priced: 'fixed',
          turnaroundDays: 14,
          score: null,
          parts: null,
          reasons: [],
          shortlisted: false,
          source: 'bid',
        },
      ],
    },
  });
  await page.goto(`/sourcing.html?request=${REQUEST}`);
  const bid = page.locator('#candidate-rows tr').nth(2);
  await expect(bid).toContainText('kolkata-devs');
  await expect(bid).toContainText('R7 500,00 fixed');
  await expect(bid).toContainText('14 days');
  await expect(bid).toContainText('Not scored');
  await expect(bid).toContainText(
    'A bid on the Freelancer.com post from IN; not ranked, compare it by hand.',
  );
});

test('an Upwork post is recorded as posted by hand only once approved', async ({ page }) => {
  const requests = await openRequest(page, {
    posts: [post({ id: 'p-upwork', platform: 'upwork', manual: true })],
  });
  const record = page.getByRole('button', { name: 'Record the Upwork post as posted by hand' });
  await expect(record).toBeDisabled();
  await expect(record).toHaveAttribute(
    'title',
    'Approve the post first, then post it by hand and record it here.',
  );
  await page.getByRole('button', { name: 'Approve the Upwork post' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#posts-status')).toHaveText('Approved the Upwork post.');
  await page.getByRole('button', { name: 'Record the Upwork post as posted by hand' }).click();
  await expect(page.locator('#posts-status')).toHaveText(
    'Recorded the Upwork post as posted by hand.',
  );
  expect(requests.find((r) => r.path.endsWith('/posted'))?.path).toBe(
    '/v1/sourcing-posts/p-upwork/posted',
  );
  await expect(page.locator('#posts article')).toContainText('posted 23/09/2026 14:30 by hand');
});

test('Close asks first and closes the post', async ({ page }) => {
  await openRequest(page, { posts: [post({})] });
  await page.getByRole('button', { name: 'Close the Freelancer.com post' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close the post' }).click();
  await expect(page.locator('#posts-status')).toHaveText('Closed the Freelancer.com post.');
  await expect(page.locator('#posts article')).toHaveAttribute('data-status', 'closed');
  await expect(page.getByRole('button', { name: 'Close the Freelancer.com post' })).toBeDisabled();
});

test('a viewer can read the posts but not draft, edit, approve or close them', async ({ page }) => {
  await openRequest(page, { role: 'viewer', posts: [post({})] });
  await expect(page.getByRole('button', { name: 'Draft a post' })).toHaveAttribute(
    'title',
    'Your role can view posts but not draft them.',
  );
  for (const [name, title] of [
    ['Edit the Freelancer.com post', 'Your role can view posts but not change them.'],
    ['Approve the Freelancer.com post', 'Your role can view posts but not approve them.'],
    ['Close the Freelancer.com post', 'Your role can view posts but not change them.'],
  ] as const) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', title);
  }
});

test('a request is opened and a candidate repriced and shortlisted from the keyboard, in reading order', async ({
  page,
}) => {
  const requests = await open(page);
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#request-status')).toContainText('Opened the sourcing request');
  const reprice = page.getByRole('button', { name: 'Reprice the bid with Thandi Web’s quote' });
  await reprice.focus();
  // The row reads left to right: Reprice sits in the Margin column, before Shortlist.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Shortlist Thandi Web' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(reprice).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#request-status')).toContainText(
    'Asked for the bid to be priced with Thandi Web’s quote.',
  );
  await page.getByRole('button', { name: 'Shortlist Thandi Web' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#request-status')).toHaveText('Shortlisted Thandi Web.');
  expect(
    requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path.split('/').pop()}`),
  ).toEqual(['POST reprice', `PATCH ${THANDI}`]);
  await expect(page.getByLabel('Platform')).toHaveAttribute('id', 'post-platform');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openRequest(page);
  await expectNoSidewaysScroll(page);
});
