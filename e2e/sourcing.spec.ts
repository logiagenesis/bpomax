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
}

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  let shortlisted: string[] = [];
  const posts = [...(options.posts ?? [])];
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
        const row = posts.find((p) => p.id === parts.pop());
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
        return route.fulfill({ json: { post: row } });
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
  const requests = await openRequest(page, { posts: [post({})] });
  await page.getByRole('button', { name: 'Approve the Freelancer.com post' }).click();
  await expect(page.getByRole('dialog')).toContainText('Approve the Freelancer.com post?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.path.endsWith('/approve'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve the Freelancer.com post' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#posts-status')).toHaveText('Approved the Freelancer.com post.');
  await expect(page.locator('#posts article')).toContainText('approved by Ayanda Nkosi via web');
  const approve = page.getByRole('button', { name: 'Approve the Freelancer.com post' });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute(
    'title',
    'This post is approved, so it cannot be approved.',
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

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openRequest(page);
  await expectNoSidewaysScroll(page);
});
