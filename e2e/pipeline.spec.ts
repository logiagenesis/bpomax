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
 * ARB-310: the pipeline page and a job's delivery order. The API is an in-memory copy, at
 * the network edge, of apps/api/src/routes/delivery.ts (tested against real Postgres in
 * routes/delivery.test.ts, where the moves' rules and the reconciliation are proved).
 */
const WON = 'aaaaaaaa-0000-4000-8000-000000000091';
const APPLIED = 'aaaaaaaa-0000-4000-8000-000000000092';
const ORDER = 'aaaaaaaa-0000-4000-8000-000000000093';
const HANDOVER_REASON =
  '2 handover items are not ticked yet; the supplier starts once the handover is complete.';

function items() {
  return [
    {
      id: WON,
      jobId: 'j1',
      jobTitle: 'Shopify store rebuild',
      platform: 'freelancer',
      stage: 'won',
      valueMinor: '1500000',
      currency: 'ZAR',
      retainer: false,
      retainerMonthlyMinor: null,
      stageChangedAt: '2026-09-22T08:00:00Z',
      deliveryOrderId: ORDER,
      deliveryStatus: 'draft',
    },
    {
      id: APPLIED,
      jobId: 'j2',
      jobTitle: 'Landing page',
      platform: 'freelancer',
      stage: 'applied',
      valueMinor: '400000',
      currency: 'ZAR',
      retainer: false,
      retainerMonthlyMinor: null,
      stageChangedAt: '2026-09-21T08:00:00Z',
      deliveryOrderId: null,
      deliveryStatus: null,
    },
  ];
}

function order(partial: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    pipelineItemId: WON,
    status: 'draft',
    jobTitle: 'Shopify store rebuild',
    briefTitle: 'Shopify store rebuild',
    pipelineStage: 'won',
    supplierName: 'Thandi Web',
    supplierId: 's1',
    supplierCandidateId: 'c1',
    sourcingRequestId: 'r1',
    agreedCostMinor: '900050',
    currency: 'ZAR',
    due: '2026-10-30',
    milestones: [
      { title: 'Full delivery', amountMinor: 900050, due: '2026-10-30', status: 'pending' },
    ],
    milestonesTotalMinor: '900050',
    reconciled: true,
    handover: [
      {
        key: 'scope',
        text: 'Share the brief’s scope with the supplier: the outcome and 1 must-have, without the client’s name or contact details.',
        done: false,
      },
      {
        key: 'milestones',
        text: 'Agree the milestones and the cost with the supplier in writing.',
        done: false,
      },
    ],
    handedOverAt: null,
    deliveredAt: null,
    acceptedAt: null,
    cancelledAt: null,
    moves: { assigned: [], cancelled: [] },
    createdAt: '2026-09-23T10:00:00Z',
    updatedAt: '2026-09-23T10:00:00Z',
    ...partial,
  };
}

interface Options {
  role?: Role;
  none?: boolean;
  order?: ReturnType<typeof order>;
}

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  const board = items();
  let current = options.order ?? order();
  return serveApi(
    page,
    {
      'GET /v1/pipeline': (_req, route) =>
        route.fulfill({
          json: {
            stages: [
              'applied',
              'replied',
              'discovery',
              'briefed',
              'sourcing',
              'won',
              'in_delivery',
              'delivered',
              'paid',
              'lost',
            ],
            items: options.none ? [] : board,
          },
        }),
      'PATCH /v1/pipeline-items/:id': (req, route) => {
        const item = board.find((i) => req.path.endsWith(i.id))!;
        item.stage = (req.body as { stage: string }).stage;
        return route.fulfill({ json: { id: item.id, stage: item.stage } });
      },
      'GET /v1/delivery-orders/:id': (req, route) =>
        req.path.endsWith(ORDER)
          ? route.fulfill({ json: { order: current } })
          : route.fulfill({ status: 404, json: { error: 'no such delivery order' } }),
      'PATCH /v1/delivery-orders/:id': (req, route) => {
        const b = req.body as {
          agreedCostMinor: number;
          milestones: { title: string; amountMinor: number; due: string | null }[];
        };
        current = order({
          ...current,
          agreedCostMinor: String(b.agreedCostMinor),
          milestones: b.milestones.map((m) => ({ ...m, status: 'pending' })),
          milestonesTotalMinor: String(b.milestones.reduce((s, m) => s + m.amountMinor, 0)),
        });
        return route.fulfill({ json: { order: current } });
      },
      'POST /v1/delivery-orders/:id/status': (req, route) => {
        const to = (req.body as { status: string }).status;
        const moves: Record<string, Record<string, string[]>> = {
          assigned: { in_progress: [HANDOVER_REASON], cancelled: [] },
          cancelled: {},
        };
        current = order({
          ...current,
          status: to,
          moves: moves[to] ?? {},
          cancelledAt: to === 'cancelled' ? '2026-09-23T12:00:00Z' : null,
        });
        return route.fulfill({ json: { order: current } });
      },
      'PATCH /v1/delivery-orders/:id/handover/:key': (req, route) => {
        const key = req.path.split('/').pop();
        const done = (req.body as { done: boolean }).done;
        const handover = current.handover.map((h) => (h.key === key ? { ...h, done } : h));
        const open = handover.filter((h) => !h.done).length;
        current = order({
          ...current,
          handover,
          moves: {
            in_progress:
              open === 0
                ? []
                : [
                    `${String(open)} handover item${open === 1 ? ' is' : 's are'} not ticked yet; the supplier starts once the handover is complete.`,
                  ],
            cancelled: [],
          },
        });
        return route.fulfill({ json: { order: current } });
      },
      'PATCH /v1/delivery-orders/:id/milestones/:index': (req, route) => {
        const index = Number(req.path.split('/').pop());
        const status = (req.body as { status: string }).status;
        current = order({
          ...current,
          milestones: current.milestones.map((m, i) => (i === index ? { ...m, status } : m)),
        });
        return route.fulfill({ json: { order: current } });
      },
    },
    { role: options.role },
  );
}

async function open(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await serve(page, options);
  await page.goto('/pipeline.html');
  await expectStatus(page, /Loaded \d+ jobs? in the pipeline\.|No jobs in the pipeline yet\./);
  return requests;
}

async function openOrder(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await open(page, options);
  await page
    .getByRole('button', { name: 'Open the delivery order for Shopify store rebuild' })
    .click();
  await expect(page.locator('#delivery-status')).toHaveText(
    'Opened the delivery order for Shopify store rebuild.',
  );
  return requests;
}

test('the board lists the jobs by stage with their value, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Loaded 2 jobs in the pipeline.');
  await expect(page.locator('#board h2')).toHaveText(['Applied (1)', 'Won (1)']);
  const won = page.locator(`#board article[data-id="${WON}"]`);
  await expect(won).toContainText('Shopify store rebuild');
  await expect(won).toContainText('R15 000,00');
  await expect(won).toContainText('since 22/09/2026');
  await expect(won).toContainText('delivery draft');
  await expect(page.getByLabel('Stage for Landing page')).toHaveValue('applied');
  await expect(page.getByRole('link', { name: 'Pipeline' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('an empty board says how a job joins it', async ({ page }) => {
  await open(page, { none: true });
  await expectStatus(page, 'No jobs in the pipeline yet.');
  await expect(page.locator('#empty')).toContainText('A job joins it when its bid is submitted.');
});

test('Move asks the API and the board follows; Lost asks first, and cancelling sends nothing', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('Stage for Landing page').selectOption('lost');
  await page.getByRole('button', { name: 'Move Landing page to the chosen stage' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Mark Landing page as lost?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  await page.getByLabel('Stage for Landing page').selectOption('replied');
  await page.getByRole('button', { name: 'Move Landing page to the chosen stage' }).click();
  await expectStatus(page, 'Moved Landing page to Replied.');
  expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
    { stage: 'replied' },
  ]);
  await expect(page.locator('#board h2')).toHaveText(['Replied (1)', 'Won (1)']);
});

test('Open delivery shows the agreed cost, the reconciled total, the milestones and the handover checklist', async ({
  page,
}) => {
  await openOrder(page);
  await expect(page.locator('#delivery-title')).toHaveText('Delivery for Shopify store rebuild');
  await expect(page.locator('#delivery-meta')).toContainText(
    'Supplier Thandi Web · Draft · job won',
  );
  const figures = page.locator('#delivery-figures');
  await expect(figures).toContainText('R9 000,50');
  await expect(figures).toContainText('Yes: the milestones add up to the agreed cost.');
  await expect(figures).toContainText('30/10/2026');
  await expect(page.locator('#milestone-rows tr')).toHaveCount(1);
  await expect(page.locator('#milestone-rows tr').first()).toContainText('Full delivery');
  await expect(page.locator('#handover li')).toHaveCount(2);
  await expect(page.locator('#handover')).not.toContainText('acme-shop');
  await expect(page.getByRole('button', { name: 'Assign the supplier' })).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`order=${ORDER}`));
});

test('a split that does not add up is refused on the page in money words, and nothing is sent', async ({
  page,
}) => {
  const requests = await openOrder(page);
  await page.getByRole('button', { name: 'Add a milestone' }).click();
  await page.getByLabel('Milestone 1 amount').fill('3000.00');
  await page.getByLabel('Milestone 2 title').fill('Build');
  await page.getByLabel('Milestone 2 amount').fill('6000.00');
  await expect(page.locator('#order-total')).toHaveText(
    'The milestones add up to R9 000,00; the agreed cost is R9 000,50. They must be equal.',
  );
  await page.getByRole('button', { name: 'Save cost and milestones' }).click();
  await expect(page.locator('#order-milestones-error')).toHaveText(
    'The milestones add up to R9 000,00; the agreed cost is R9 000,50. They must be equal.',
  );
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
});

test('a split that adds up is saved as whole cents with ISO dates', async ({ page }) => {
  const requests = await openOrder(page);
  await page.getByRole('button', { name: 'Add a milestone' }).click();
  await page.getByLabel('Milestone 1 title').fill('Design');
  await page.getByLabel('Milestone 1 amount').fill('3000.00');
  await page.getByLabel('Milestone 1 due (DD/MM/YYYY)').fill('09/10/2026');
  await page.getByLabel('Milestone 2 title').fill('Build');
  await page.getByLabel('Milestone 2 amount').fill('6000.50');
  await expect(page.locator('#order-total')).toHaveText(
    'The milestones add up to the agreed cost: R9 000,50.',
  );
  await page.getByRole('button', { name: 'Save cost and milestones' }).click();
  await expect(page.locator('#delivery-status')).toHaveText('Saved the cost and milestones.');
  const sent = requests.find((r) => r.method === 'PATCH')?.body as {
    agreedCostMinor: number;
    milestones: { title: string; amountMinor: number; due: string | null }[];
  };
  expect(sent.agreedCostMinor).toBe(900050);
  expect(sent.milestones).toEqual([
    { title: 'Design', amountMinor: 300000, due: '2026-10-09', status: 'pending' },
    { title: 'Build', amountMinor: 600050, due: null, status: 'pending' },
  ]);
  await expect(page.locator('#milestone-rows tr')).toHaveCount(2);
});

test('a false date is refused on its field', async ({ page }) => {
  await openOrder(page);
  await page.getByLabel('Due (DD/MM/YYYY)', { exact: true }).fill('31/02/2026');
  await page.getByRole('button', { name: 'Save cost and milestones' }).click();
  await expect(page.locator('#order-due-error')).toHaveText('Must be a real date as DD/MM/YYYY.');
  await expect(page.getByLabel('Due (DD/MM/YYYY)', { exact: true })).toBeFocused();
});

test('Assign asks first; Start stays closed with the reason until every handover item is ticked', async ({
  page,
}) => {
  const requests = await openOrder(page);
  await page.getByRole('button', { name: 'Assign the supplier' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Assign Thandi Web?');
  await expect(dialog).toContainText('R9 000,50 and its 1 milestone');
  await dialog.getByRole('button', { name: 'Assign' }).click();
  await expect(page.locator('#delivery-status')).toHaveText('Assigned the supplier.');
  const start = page.getByRole('button', { name: 'Start the work' });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute('title', HANDOVER_REASON);
  for (const box of await page.locator('#handover input').all()) await box.check();
  await expect(page.locator('#delivery-status')).toHaveText('Ticked the handover item.');
  await expect(start).toBeEnabled();
  expect(
    requests
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.path.split('/').slice(4).join('/')}`),
  ).toEqual(['POST status', 'PATCH handover/scope', 'PATCH handover/milestones']);
});

test('once work has started, each milestone is marked from its row', async ({ page }) => {
  const requests = await openOrder(page, {
    order: order({
      status: 'in_progress',
      moves: { delivered: ['1 milestone is not delivered yet.'], cancelled: [] },
    }),
  });
  await expect(page.locator('#order-form')).toBeHidden();
  await expect(page.locator('#handover input').first()).toBeDisabled();
  await page.getByRole('button', { name: 'Mark Full delivery delivered' }).click();
  await expect(page.locator('#delivery-status')).toHaveText('Marked Full delivery delivered.');
  expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ status: 'delivered' });
  await expect(page.locator('#milestone-rows tr').first()).toContainText('Delivered');
  await expect(page.getByRole('button', { name: 'Mark Full delivery accepted' })).toBeEnabled();
});

test('Cancel asks first, as a danger, and says the sourcing request is open again', async ({
  page,
}) => {
  await openOrder(page);
  await page.getByRole('button', { name: 'Cancel the order' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Cancel the delivery order for Shopify store rebuild?');
  await dialog.getByRole('button', { name: 'Cancel the order' }).click();
  await expect(page.locator('#delivery-status')).toHaveText(
    'Cancelled the order. The sourcing request is open again for another supplier.',
  );
  await expect(page.locator('#moves')).toContainText('The order is cancelled.');
});

test('a viewer sees the board and the order but can change nothing, with the reason', async ({
  page,
}) => {
  await openOrder(page, { role: 'viewer' });
  await expect(page.getByLabel('Stage for Landing page')).toBeDisabled();
  const move = page.getByRole('button', { name: 'Move Landing page to the chosen stage' });
  await expect(move).toBeDisabled();
  await expect(move).toHaveAttribute('title', 'Your role can view the pipeline but not change it.');
  await expect(page.locator('#order-form')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Assign the supplier' })).toHaveAttribute(
    'title',
    'Your role can view the pipeline but not change it.',
  );
  await expect(page.locator('#handover input').first()).toBeDisabled();
});

test('a linked order opens; one the API cannot find says so', async ({ page }) => {
  await serve(page);
  await page.goto(`/pipeline.html?order=${ORDER}`);
  await expect(page.locator('#delivery-status')).toHaveText(
    'Opened the delivery order for Shopify store rebuild.',
  );
  await page.goto('/pipeline.html?order=aaaaaaaa-0000-4000-8000-000000000000');
  await expect(page.locator('#delivery-status')).toHaveText(
    'The API refused the request: no such delivery order.',
  );
});

test('the controls are labelled and reached by keyboard; Enter opens the order', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Stage for Shopify store rebuild').focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Move Shopify store rebuild to the chosen stage' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Open the delivery order for Shopify store rebuild' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#delivery-status')).toHaveText(
    'Opened the delivery order for Shopify store rebuild.',
  );
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openOrder(page);
  await expectNoSidewaysScroll(page);
});
