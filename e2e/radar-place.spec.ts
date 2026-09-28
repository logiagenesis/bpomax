import { expect, test, type Page } from '@playwright/test';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Place now (LI-PROMPT-BPOMAX-AUTOBID-20260928, step 3): with a token Freelancer.com
 * accepted, the project's bid panel can send the bid itself. It first asks Freelancer.com
 * for an earlier bid of the owner's on the project and sends nothing if there is one
 * (constraint 4), then POSTs the bid as F2 describes, and logs it with Freelancer's bid
 * id and the answer's status (constraint 5). Every call is answered here.
 */
const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;
const RECRUITER = ALL.find((p) => p.title === 'IT Recruiter for Interviews')!; // USD 250–750
const TOKEN = 'e2e-token-abcdefghijklmnopqrstuvwxyz-7Q9Z';
const ACCOUNT = {
  id: 1234567,
  username: 'example-user',
  role: 'freelancer',
  limited: false,
  membership: 'plus',
  bidLimit: 100,
  bidPeriod: 'month',
};
const TEMPLATE = {
  id: 'tpl-1',
  name: 'Short',
  body: 'Hello. About {title}: I can do this for {price} in {timeline_days} days.',
  isDefault: true,
};

async function open(
  page: Page,
  options: {
    token?: boolean;
    bids?: NonNullable<Parameters<typeof serveFreelancer>[1]>['bids'];
  } = {},
) {
  const token =
    options.token === false
      ? null
      : {
          token: TOKEN,
          savedAt: NOW - 60_000,
          account: ACCOUNT,
          checkedAt: NOW - 60_000,
          problem: null,
        };
  await page.addInitScript(
    ([templates, stored]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('radar.templates', JSON.stringify(templates));
      if (stored) localStorage.setItem('radar.token', JSON.stringify(stored));
    },
    [[TEMPLATE], token] as const,
  );
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, { bids: options.bids });
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  return calls;
}

async function detailOf(page: Page, title: string) {
  await page
    .locator('#feed-list > li')
    .filter({ hasText: title })
    .first()
    .locator('.radar-row__meta')
    .click();
  const dialog = page.locator('#detail');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(title);
  return dialog;
}

const confirmDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Place this bid on Freelancer.com now?' });

test('without a token there is no Place now, only Bid on Freelancer', async ({ page }) => {
  await open(page, { token: false });
  const dialog = await detailOf(page, RECRUITER.title);
  await expect(dialog.getByRole('button', { name: 'Bid on Freelancer' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Place now' })).toBeHidden();
});

test('Place now checks for an earlier bid, sends the bid, and logs it with Freelancer’s id', async ({
  page,
}) => {
  const calls = await open(page);
  const dialog = await detailOf(page, RECRUITER.title);
  await expect(dialog.getByLabel('Price (USD)')).toHaveValue('450');
  const proposal = await dialog.getByLabel('Proposal').inputValue();

  // Cancelling sends nothing.
  await dialog.getByRole('button', { name: 'Place now' }).click();
  await expect(confirmDialog(page)).toContainText(
    `A real bid on “${RECRUITER.title}” as example-user: USD 450, 7 days, with the proposal as it is here.`,
  );
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  expect(calls.bidLookups).toHaveLength(0);
  expect(calls.bidsSent).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Place now' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
  await expect(page.locator('#status')).toHaveText(
    `Placed your bid on “${RECRUITER.title}” on Freelancer.com (bid 900000001). It is logged.`,
  );
  await expect(dialog).toBeHidden();

  expect(calls.bidLookups).toHaveLength(1);
  expect(calls.bidLookups[0]!.token).toBe(TOKEN);
  expect(calls.bidLookups[0]!.url.searchParams.getAll('projects[]')).toEqual([
    String(RECRUITER.id),
  ]);
  expect(calls.bidLookups[0]!.url.searchParams.getAll('bidders[]')).toEqual(['1234567']);
  expect(calls.bidsSent).toEqual([
    {
      token: TOKEN,
      body: {
        project_id: RECRUITER.id,
        bidder_id: 1234567,
        amount: 450,
        period: 7,
        milestone_percentage: 100,
        description: proposal.trim(),
      },
    },
  ]);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.log') ?? '[]'));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    projectId: RECRUITER.id,
    price: 450,
    days: 7,
    placedBy: 'manual',
    freelancerBidId: '900000001',
    apiStatus: 200,
    status: 'sent',
  });

  await page.getByRole('tab', { name: 'Bids' }).click();
  await expect(page.locator('#bid-list > li .radar-row__meta')).toContainText(
    'Freelancer.com bid 900000001',
  );

  // Once bid on, the project offers Place now no more.
  await page.getByRole('tab', { name: 'Feed' }).click();
  await page.locator('#filters-box > summary').click();
  await page.getByLabel('Hide projects already bid on or dismissed').uncheck();
  const again = await detailOf(page, RECRUITER.title);
  await expect(again.getByRole('button', { name: 'Place now' })).toBeHidden();
});

test('when Freelancer.com already has his bid, nothing new is sent and the bid is logged', async ({
  page,
}) => {
  const calls = await open(page, {
    bids: { existing: { id: 777, bidder_id: 1234567, project_id: RECRUITER.id, amount: 400 } },
  });
  const dialog = await detailOf(page, RECRUITER.title);
  await dialog.getByRole('button', { name: 'Place now' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
  await expect(page.locator('#status')).toHaveText(
    `Freelancer.com already has your bid 777 on “${RECRUITER.title}”, so nothing new was sent. It is logged.`,
  );
  expect(calls.bidsSent).toHaveLength(0);
});

test('a refused bid is shown on the page and not logged', async ({ page }) => {
  const calls = await open(page, { bids: { refuse: 400 } });
  const dialog = await detailOf(page, RECRUITER.title);
  await dialog.getByRole('button', { name: 'Place now' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
  await expect(dialog.locator('#detail-status')).toHaveText(
    'Freelancer.com refused placing the bid (HTTP 400: Refused in the e2e).',
  );
  expect(calls.bidsSent).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
  await expect(dialog.getByRole('button', { name: 'Place now' })).toBeEnabled();
});
