import { expect, test, type Page } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Role,
} from './helpers.js';

/** Rows as GET /v1/proposals returns them (apps/api/src/routes/proposals.ts). */
function proposal(partial: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    job_id: crypto.randomUUID(),
    job_title: 'A job',
    platform: 'freelancer',
    status: 'queued',
    body: 'Hello,\n\nWe would build this in seven days.',
    amount_minor: '200000',
    currency: 'ZAR',
    delivery_days: 7,
    milestones: [{ title: 'Design' }, { title: 'Build' }],
    approved_by: null,
    approved_by_name: null,
    approved_via: null,
    submitted_at: null,
    failure_reason: null,
    created_at: '2026-09-22T08:05:00Z',
    updated_at: '2026-09-22T08:05:00Z',
    score: 70,
    verdict: 'go',
    estimate_expected_minor: '150000',
    estimate_currency: 'ZAR',
    estimate_method: 'rate_card',
    margin_minor: '75000',
    margin_pct: '37.500',
    margin_currency: 'ZAR',
    fx_rate_used: null,
    fx_rate_at: null,
    ...partial,
  };
}

/** Rows as GET /v1/outbound-messages returns them (apps/api/src/routes/messages.ts, ARB-122). */
function reply(partial: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    externalThreadId: '5001',
    clientHandle: 'acme-shop',
    jobId: crypto.randomUUID(),
    jobTitle: 'Shopify store rebuild',
    body: 'Yes, Monday works. I will send a plan today.',
    state: 'queued',
    approvedBy: null,
    approvedByName: null,
    approvedVia: null,
    sentAt: null,
    rejectedAt: null,
    failureReason: null,
    externalMessageId: null,
    createdAt: '2026-09-23T09:59:00Z',
    updatedAt: '2026-09-23T09:59:00Z',
    lastInbound: { body: 'Hi, can you start on Monday?', sentAt: '2026-09-23T09:58:00Z' },
    ...partial,
  };
}

/** Rows as GET /v1/sourcing-posts returns them (apps/api/src/routes/sourcing-posts.ts, ARB-210). */
function sourcingPost(partial: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    sourcingRequestId: 'aaaaaaaa-0000-4000-8000-000000000071',
    briefTitle: 'Shopify store rebuild',
    platform: 'freelancer',
    manual: false,
    title: 'Shopify: An online shop that takes orders',
    body: 'An online shop that takes orders\n\nMust have:\n- Checkout',
    budgetMinMinor: '800000',
    budgetMaxMinor: '1200000',
    currency: 'ZAR',
    status: 'draft',
    approvedBy: null,
    approvedByName: null,
    approvedVia: null,
    externalId: null,
    postedAt: null,
    failureReason: null,
    createdAt: '2026-09-23T09:57:00Z',
    updatedAt: '2026-09-23T09:57:00Z',
    ...partial,
  };
}

/** Serves an in-memory queue that the actions change, the way the API would. */
async function open(
  page: Page,
  options: {
    role?: Role;
    paused?: boolean;
    rows?: ReturnType<typeof proposal>[];
    replies?: ReturnType<typeof reply>[];
    posts?: ReturnType<typeof sourcingPost>[];
  } = {},
) {
  const replies = options.replies ?? [];
  const posts = options.posts ?? [];
  const rows = options.rows ?? [
    proposal({ job_title: 'Shopify store rebuild' }),
    proposal({
      job_title: 'Dashboard in USD',
      currency: 'USD',
      amount_minor: '150000',
      margin_minor: '50000',
      margin_pct: '33.333',
      margin_currency: 'USD',
      fx_rate_used: '18.12345678',
      fx_rate_at: '2026-09-21T14:00:00Z',
      milestones: [],
    }),
    proposal({
      job_title: 'Sent already',
      status: 'submitted',
      approved_by_name: 'Ayanda Nkosi',
      approved_via: 'telegram',
      submitted_at: '2026-09-20T08:00:00Z',
    }),
  ];
  await signedIn(page);
  const requests = await serveApi(
    page,
    {
      'GET /v1/proposals': (request, route) => {
        const status = request.query.get('status') ?? 'queued';
        return route.fulfill({
          json: {
            proposals: rows.filter((row) => status === 'all' || row.status === status),
            biddingPaused: options.paused ?? false,
          },
        });
      },
      'GET /v1/outbound-messages': (request, route) => {
        const state = request.query.get('status') ?? 'queued';
        return route.fulfill({
          json: { messages: replies.filter((row) => state === 'all' || row.state === state) },
        });
      },
      'GET /v1/sourcing-posts': (request, route) => {
        const state = request.query.get('status') ?? 'draft';
        return route.fulfill({
          json: { posts: posts.filter((row) => state === 'all' || row.status === state) },
        });
      },
      'POST /v1/sourcing-posts/:id/:action': (request, route) => {
        const row = posts.find((r) => request.path.includes(r.id))!;
        if (request.path.endsWith('/approve'))
          Object.assign(row, {
            status: 'approved',
            approvedByName: 'Ayanda Nkosi',
            approvedVia: 'web',
          });
        if (request.path.endsWith('/close')) Object.assign(row, { status: 'closed' });
        return route.fulfill({ json: { post: row, queued: false } });
      },
      'POST /v1/outbound-messages/:id/approve': (request, route) => {
        const row = replies.find((r) => request.path.includes(r.id))!;
        row.state = 'approved';
        row.approvedByName = 'Ayanda Nkosi';
        row.approvedVia = 'web';
        return route.fulfill({ json: { message: row, queued: true } });
      },
      'POST /v1/outbound-messages/:id/reject': (request, route) => {
        const row = replies.find((r) => request.path.includes(r.id))!;
        row.state = 'rejected';
        row.failureReason = (request.body as { reason: string }).reason;
        return route.fulfill({ json: { message: row } });
      },
      'PATCH /v1/outbound-messages/:id': (request, route) => {
        const row = replies.find((r) => request.path.includes(r.id))!;
        row.body = (request.body as { body: string }).body;
        row.state = 'queued';
        row.approvedByName = null;
        return route.fulfill({ json: { message: row } });
      },
      'POST /v1/proposals/bulk': (request, route) => {
        const { action, ids, reason } = request.body as {
          action: string;
          ids: string[];
          reason?: string;
        };
        const results = ids.map((id) => {
          const row = rows.find((r) => r.id === id);
          if (!row) return { id, ok: false, error: 'no such bid' };
          if (row.status !== 'queued')
            return { id, ok: false, error: `This bid is ${row.status}.` };
          row.status = action === 'approve' ? 'approved' : 'rejected';
          if (reason) row.failure_reason = reason;
          return { id, ok: true };
        });
        return route.fulfill({ json: { results } });
      },
      'POST /v1/proposals/:id/approve': (request, route) => {
        const row = rows.find((r) => request.path.includes(r.id))!;
        row.status = 'approved';
        row.approved_by_name = 'Ayanda Nkosi';
        row.approved_via = 'web';
        return route.fulfill({
          json: { proposal: row, biddingPaused: options.paused ?? false, queued: true },
        });
      },
      'POST /v1/proposals/:id/reject': (request, route) => {
        const row = rows.find((r) => request.path.includes(r.id))!;
        row.status = 'rejected';
        row.failure_reason = (request.body as { reason: string }).reason;
        return route.fulfill({ json: { proposal: row } });
      },
      'PATCH /v1/proposals/:id': (request, route) => {
        const row = rows.find((r) => request.path.includes(r.id))!;
        row.body = (request.body as { body: string }).body;
        row.status = 'queued';
        return route.fulfill({ json: { proposal: row } });
      },
    },
    { role: options.role },
  );
  await page.goto('/approvals.html');
  await expectStatus(page, /^Loaded .+\.$|^Nothing is waiting for approval\.$/);
  return { requests, rows, replies, posts };
}

test('shows each waiting bid with its figures from the stored rows, and the margin in rand at the stored rate', async ({
  page,
}) => {
  await open(page);
  const cards = page.locator('#list article');
  await expect(cards).toHaveCount(2);
  const first = cards.nth(0);
  await expect(first).toContainText('Shopify store rebuild');
  await expect(first).toContainText('R2 000,00 · 7 days · 2 milestones');
  await expect(first).toContainText('70 (go)');
  await expect(first).toContainText('R1 500,00 (rate card)');
  await expect(first).toContainText('R750,00 (37,500%) · R750,00 in rand');
  await expect(first).toContainText('22/09/2026 10:05');
  await expect(first.locator('.bid__body')).toHaveText(
    'Hello,\n\nWe would build this in seven days.',
  );
  const usd = cards.nth(1);
  // USD 500,00 × 18,12345678 = R9 061,73 (9 061,728 39 rounded half up to the cent).
  await expect(usd).toContainText(
    'USD 500,00 (33,333%) · R9 061,73 in rand at the rate of 21/09/2026 16:00',
  );
  await expect(usd).toContainText('USD 1 500,00 · 7 days · 0 milestones');
  await expect(page.locator('#paused')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Approvals' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('the filter shows other states, including sent bids with their approver, and lands in the address bar', async ({
  page,
}) => {
  const { requests } = await open(page);
  await page.getByLabel('Show', { exact: true }).selectOption('submitted');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 bid.');
  expect(
    requests
      .filter((r) => r.path === '/v1/proposals')
      .at(-1)
      ?.query.get('status'),
  ).toBe('submitted');
  // The replies are asked for in their own words: a sent reply is `sent`.
  expect(
    requests
      .filter((r) => r.path === '/v1/outbound-messages')
      .at(-1)
      ?.query.get('status'),
  ).toBe('sent');
  const card = page.locator('#list article').first();
  await expect(card).toContainText('Sent');
  await expect(card).toContainText('Ayanda Nkosi via telegram');
  await expect(card.getByRole('button', { name: /^Approve/ })).toBeDisabled();
  await expect(card.getByRole('button', { name: /^Edit/ })).toBeDisabled();
  await expect(card.getByRole('button', { name: /^Reject/ })).toBeDisabled();
  await expect(card.getByRole('button', { name: /^Edit/ })).toHaveAttribute(
    'title',
    'This bid has been sent.',
  );
  await expect(page).toHaveURL(/status=submitted/);

  await page.getByLabel('Show', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 3 bids.');
});

test('approve asks for confirmation; cancelling sends nothing', async ({ page }) => {
  const { requests } = await open(page);
  await page.getByRole('button', { name: 'Approve Shopify store rebuild' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Approve this bid?');
  await expect(dialog).toContainText('R2 000,00 for “Shopify store rebuild”');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
});

test('approve, confirmed, posts the approval and refreshes the list', async ({ page }) => {
  const { requests, rows } = await open(page);
  await page.getByRole('button', { name: 'Approve Shopify store rebuild' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expectStatus(page, 'Approved “Shopify store rebuild”. The sender has it.');
  expect(requests.find((r) => r.method === 'POST')?.path).toBe(
    `/v1/proposals/${rows[0]!.id}/approve`,
  );
  await expect(page.locator('#list article')).toHaveCount(1);
});

test('when bidding is paused the page says so, and so does an approval', async ({ page }) => {
  await open(page, { paused: true });
  await expect(page.locator('#paused')).toBeVisible();
  await page.getByRole('button', { name: 'Approve Shopify store rebuild' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expectStatus(
    page,
    'Approved “Shopify store rebuild”. Bidding is paused, so it waits for /resume.',
  );
});

test('edit opens the text, refuses blank words, saves new ones and puts the bid back in the queue', async ({
  page,
}) => {
  const { requests, rows } = await open(page);
  const card = page.locator('#list article').first();
  await card.getByRole('button', { name: 'Edit Shopify store rebuild' }).click();
  const textarea = card.getByLabel('Bid text');
  await expect(textarea).toBeFocused();
  await textarea.fill('   ');
  await card.getByRole('button', { name: 'Save text' }).click();
  await expect(card.locator('.field__error')).toHaveText('Must not be blank.');
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);

  await textarea.fill('New words, same price.');
  await card.getByRole('button', { name: 'Save text' }).click();
  await expectStatus(
    page,
    'Saved the new text for “Shopify store rebuild”. It needs approval again.',
  );
  const patch = requests.find((r) => r.method === 'PATCH');
  expect(patch?.path).toBe(`/v1/proposals/${rows[0]!.id}`);
  expect(patch?.body).toEqual({ body: 'New words, same price.' });
  await expect(page.locator('#list article').first().locator('.bid__body')).toHaveText(
    'New words, same price.',
  );
});

test('cancelling an edit puts the original text back', async ({ page }) => {
  await open(page);
  const card = page.locator('#list article').first();
  await card.getByRole('button', { name: 'Edit Shopify store rebuild' }).click();
  await card.getByLabel('Bid text').fill('Half-typed');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.locator('.bid__body')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit Shopify store rebuild' })).toBeFocused();
  await card.getByRole('button', { name: 'Edit Shopify store rebuild' }).click();
  await expect(card.getByLabel('Bid text')).toHaveValue(
    'Hello,\n\nWe would build this in seven days.',
  );
});

test('reject asks for a reason, will not take an empty one, and records it', async ({ page }) => {
  const { requests, rows } = await open(page);
  await page.getByRole('button', { name: 'Reject Dashboard in USD' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Reject “Dashboard in USD”?');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog).toBeVisible();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  await dialog.getByLabel(/Reason/).fill('Budget too low for the scope');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expectStatus(page, 'Rejected “Dashboard in USD”.');
  const post = requests.find((r) => r.method === 'POST');
  expect(post?.path).toBe(`/v1/proposals/${rows[1]!.id}/reject`);
  expect(post?.body).toEqual({ reason: 'Budget too low for the scope' });
  await expect(page.locator('#list article')).toHaveCount(1);
});

test('cancelling a rejection sends nothing', async ({ page }) => {
  const { requests } = await open(page);
  await page.getByRole('button', { name: 'Reject Dashboard in USD' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
});

test('select all, then bulk approve after confirming, reports the count and refreshes', async ({
  page,
}) => {
  const { requests, rows } = await open(page);
  await expect(page.getByRole('button', { name: 'Approve selected' })).toBeDisabled();
  await page.getByLabel('Select all shown').check();
  await expect(page.locator('#selected-count')).toHaveText('2 selected.');
  await page.getByRole('button', { name: 'Approve selected' }).click();
  await expect(page.getByRole('dialog')).toContainText('Approve 2 bids?');
  await page.getByRole('dialog').getByRole('button', { name: 'Approve all selected' }).click();
  await expectStatus(page, 'Approved 2 of 2.');
  const bulk = requests.find((r) => r.path === '/v1/proposals/bulk');
  expect(bulk?.body).toEqual({ action: 'approve', ids: [rows[0]!.id, rows[1]!.id] });
  await expectStatus(page, 'Approved 2 of 2.');
  await expect(page.locator('#list article')).toHaveCount(0);
  await expect(page.locator('#empty')).toBeVisible();
});

test('one selected bid, bulk rejected with a reason; a bid that moved on is reported by name', async ({
  page,
}) => {
  const { requests, rows } = await open(page);
  rows[1]!.status = 'approved'; // moved on since the page loaded
  await page.getByLabel('Select Shopify store rebuild').check();
  await page.getByLabel('Select Dashboard in USD').check();
  await expect(page.locator('#selected-count')).toHaveText('2 selected.');
  await page.getByRole('button', { name: 'Reject selected' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Reason/)
    .fill('Not this month');
  await page.getByRole('dialog').getByRole('button', { name: 'Reject all selected' }).click();
  await expectStatus(page, 'Rejected 1 of 2. Not done: Dashboard in USD: This bid is approved..');
  expect(requests.find((r) => r.path === '/v1/proposals/bulk')?.body).toMatchObject({
    action: 'reject',
    reason: 'Not this month',
  });
});

test('a viewer sees the queue with every control off', async ({ page }) => {
  await open(page, { role: 'viewer' });
  await expect(page.getByRole('button', { name: 'Approve Shopify store rebuild' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve Shopify store rebuild' })).toHaveAttribute(
    'title',
    'Your role can view bids but not change them.',
  );
  await expect(page.getByRole('button', { name: 'Edit Shopify store rebuild' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject Shopify store rebuild' })).toBeDisabled();
  await expect(page.getByLabel('Select Shopify store rebuild')).toBeDisabled();
  await expect(page.getByLabel('Select all shown')).toBeDisabled();
});

test('refresh asks again', async ({ page }) => {
  const { requests } = await open(page);
  const before = requests.filter((r) => r.path === '/v1/proposals').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expectStatus(page, 'Loaded 2 bids.');
  expect(requests.filter((r) => r.path === '/v1/proposals').length).toBe(before + 1);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});

test('a waiting reply is shown beside the bids with the client message quoted; approving it, confirmed, hands it to the sender', async ({
  page,
}) => {
  const { requests } = await open(page, { replies: [reply({})] });
  await expectStatus(page, 'Loaded 2 bids and 1 reply.');
  const card = page.locator('#list article[data-kind="reply"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Reply to acme-shop');
  await expect(card).toContainText('Shopify store rebuild');
  await expect(card).toContainText('Hi, can you start on Monday? (23/09/2026 11:58)');
  await expect(card).toContainText('Yes, Monday works. I will send a plan today.');
  await expect(card).toContainText('Waiting');

  await page.getByRole('button', { name: 'Approve reply to acme-shop' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'The reply to “acme-shop” about “Shopify store rebuild” will be handed to the sender.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);

  await page.getByRole('button', { name: 'Approve reply to acme-shop' }).click();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expectStatus(page, 'Approved the reply to “acme-shop”. The sender has it.');
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
    expect.stringMatching(/^\/v1\/outbound-messages\/[0-9a-f-]+\/approve$/),
  ]);
  // Approved, it leaves the waiting list.
  await expect(card).toHaveCount(0);
  await expectStatus(page, 'Approved the reply to “acme-shop”. The sender has it.');
});

test('a reply can be edited, which clears its approval, and rejected with a reason', async ({
  page,
}) => {
  const { requests } = await open(page, {
    replies: [reply({ state: 'approved', approvedByName: 'Ayanda Nkosi', approvedVia: 'web' })],
  });
  await page.getByLabel('Show', { exact: true }).selectOption('approved');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 reply.');
  const card = page.locator('#list article[data-kind="reply"]');
  await expect(card).toContainText('Ayanda Nkosi via web');
  await expect(card.getByRole('button', { name: /^Approve/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Edit reply to acme-shop' }).click();
  const textarea = page.getByLabel('Reply text');
  await expect(textarea).toBeFocused();
  await textarea.fill('   ');
  await page.getByRole('button', { name: 'Save text' }).click();
  await expect(card.locator('.field__error')).toHaveText('Must not be empty.');
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  await textarea.fill('Yes, Monday works.');
  await page.getByRole('button', { name: 'Save text' }).click();
  await expectStatus(
    page,
    'Saved the new text for the reply to “acme-shop”. It needs approval again.',
  );
  expect(requests.filter((r) => r.method === 'PATCH')[0]?.body).toEqual({
    body: 'Yes, Monday works.',
  });

  await page.getByLabel('Show', { exact: true }).selectOption('queued');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 2 bids and 1 reply.');
  await page.getByRole('button', { name: 'Reject reply to acme-shop' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason (kept with the reply and in the audit log)').fill('Too vague');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expectStatus(page, 'Rejected the reply to “acme-shop”.');
  const rejectPost = requests.find((r) => r.method === 'POST' && r.path.endsWith('/reject'));
  expect(rejectPost?.body).toEqual({ reason: 'Too vague' });
});

test('a viewer sees a waiting reply and can change nothing about it', async ({ page }) => {
  await open(page, { role: 'viewer', replies: [reply({})] });
  const card = page.locator('#list article[data-kind="reply"]');
  for (const name of [
    'Approve reply to acme-shop',
    'Edit reply to acme-shop',
    'Reject reply to acme-shop',
  ]) {
    await expect(page.getByRole('button', { name })).toBeDisabled();
    await expect(page.getByRole('button', { name })).toHaveAttribute(
      'title',
      'Your role can view replies but not change them.',
    );
  }
  await expect(card).toContainText('Reply to acme-shop');
});

test('a waiting sourcing post is listed beside the bids; approving it, confirmed, approves it', async ({
  page,
}) => {
  const { requests } = await open(page, { replies: [reply({})], posts: [sourcingPost({})] });
  await expectStatus(page, 'Loaded 2 bids, 1 reply and 1 sourcing post.');
  const card = page.locator('#list article[data-kind="post"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Sourcing post on Freelancer.com');
  await expect(card).toContainText('Waiting');
  await expect(card).toContainText('Shopify: An online shop that takes orders');
  await expect(card).toContainText('R8 000,00 to R12 000,00');
  await expect(card).toContainText('23/09/2026 11:57');
  const name = 'Approve the Freelancer.com post for Shopify store rebuild';
  await page.getByRole('button', { name }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Approve the Freelancer.com post?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name }).click();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expectStatus(
    page,
    'Approved the Freelancer.com post for Shopify store rebuild. It is posted when live mode allows; until then the audit log shows what would be sent.',
  );
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
    expect.stringMatching(/^\/v1\/sourcing-posts\/[0-9a-f-]+\/approve$/),
  ]);
  await expect(card).toHaveCount(0);
});

test('a Freelancer.com post with no budget cannot be approved here, and Edit goes to its sourcing request', async ({
  page,
}) => {
  await open(page, {
    posts: [sourcingPost({ budgetMinMinor: null, budgetMaxMinor: null, currency: null })],
  });
  const approve = page.getByRole('button', {
    name: 'Approve the Freelancer.com post for Shopify store rebuild',
  });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute(
    'title',
    'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
  );
  await expect(page.locator('#list article[data-kind="post"]')).toContainText('No budget');
  const edit = page.getByRole('link', {
    name: 'Edit the Freelancer.com post for Shopify store rebuild on the sourcing page',
  });
  await expect(edit).toHaveAttribute(
    'href',
    'sourcing.html?request=aaaaaaaa-0000-4000-8000-000000000071',
  );
});

test('Close asks first and closes the post; the Rejected filter shows closed posts', async ({
  page,
}) => {
  const { requests } = await open(page, {
    posts: [sourcingPost({ platform: 'upwork', manual: true })],
  });
  await page
    .getByRole('button', { name: 'Close the Upwork post for Shopify store rebuild' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Close the Upwork post?');
  await dialog.getByRole('button', { name: 'Close the post' }).click();
  await expectStatus(page, 'Closed the Upwork post for Shopify store rebuild.');
  await page.getByLabel('Show', { exact: true }).selectOption('rejected');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 sourcing post.');
  expect(
    requests
      .filter((r) => r.path === '/v1/sourcing-posts')
      .at(-1)
      ?.query.get('status'),
  ).toBe('closed');
  const card = page.locator('#list article[data-kind="post"]');
  await expect(card).toContainText('Closed');
  await expect(
    card.getByRole('button', { name: 'Close the Upwork post for Shopify store rebuild' }),
  ).toHaveAttribute('title', 'This post is closed.');
});

test('a viewer sees a waiting sourcing post and can change nothing about it', async ({ page }) => {
  await open(page, { role: 'viewer', posts: [sourcingPost({})] });
  for (const name of [
    'Approve the Freelancer.com post for Shopify store rebuild',
    'Close the Freelancer.com post for Shopify store rebuild',
  ]) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      'title',
      'Your role can view sourcing posts but not change them.',
    );
  }
});
