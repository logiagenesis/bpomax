import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Auto-bid (LI-PROMPT-BPOMAX-AUTOBID-20260928, steps 4 and 5, constraints 3 to 6): off
 * by default; switched on only once every guardrail is set, after a confirm; then each
 * read of the feed bids on the fresh projects that meet the rules, logs them as placed
 * automatically, and never bids twice. Stop turns it off at once. Every Freelancer.com
 * call is answered here; nothing reaches the real site.
 *
 * The saved search, read 5 minutes after its newest project, has two projects under 15
 * minutes old that need Building Design (816), the skill made in-house below:
 * - "Retail Store Interior Design", INR 1 500–12 500, 6 minutes old: 60 % of 12 500 is 7 500;
 * - "Commercial Building AC Design Plans", USD 10–30, 7 minutes old: 60 % of 30 is 18.
 */
const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;
const RETAIL = ALL.find((p) => p.title === 'Retail Store Interior Design')!;
const AC = ALL.find((p) => p.title === 'Commercial Building AC Design Plans')!;
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
  body: 'Hello. I can do {title} for {price} in {timeline_days} days.',
  isDefault: true,
};

async function open(
  page: Page,
  options: {
    ready?: boolean;
    autobid?: Record<string, unknown>;
    bids?: NonNullable<Parameters<typeof serveFreelancer>[1]>['bids'];
  } = {},
) {
  const ready = options.ready !== false;
  await page.addInitScript(
    ([seed]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(seed)) {
        localStorage.setItem(`radar.${key}`, JSON.stringify(value));
      }
    },
    [
      {
        ...(ready
          ? {
              templates: [TEMPLATE],
              settings: { inHouse: [{ id: 816, name: 'Building Design' }], monthlyLimit: 100 },
              token: {
                token: TOKEN,
                savedAt: NOW - 60_000,
                account: ACCOUNT,
                checkedAt: NOW - 60_000,
                problem: null,
              },
            }
          : {}),
        ...(options.autobid ? { autobid: options.autobid } : {}),
      },
    ] as const,
  );
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, { bids: options.bids });
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  return calls;
}

async function switchOn(page: Page) {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Switch Auto-bid on' }).click();
  const confirm = page.getByRole('dialog', { name: 'Switch Auto-bid on?' });
  await expect(confirm).toContainText('real bids on Freelancer.com as example-user by itself');
  await confirm.getByRole('button', { name: 'Switch on' }).click();
}

const bar = (page: Page) => page.locator('#autobid-bar');

test('Auto-bid is off by default and cannot be switched on until every guardrail is set', async ({
  page,
}) => {
  const calls = await open(page, { ready: false });
  await expect(bar(page)).toBeHidden();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#autobid-state')).toHaveText('Auto-bid is off.');
  await expect(page.getByLabel('Most automatic bids a day')).toHaveValue('10');
  await expect(page.getByLabel('Lowest rank score to bid on')).toHaveValue('70');
  await expect(page.getByLabel('Oldest project to bid on, minutes')).toHaveValue('15');
  await expect(page.locator('#autobid-problems > li')).toHaveText([
    'Paste a Freelancer token that Freelancer.com accepts.',
    'Set the bids your membership allows a month, under Bidding.',
    'Pick at least one skill delivered in-house.',
    'Mark one template as the default.',
  ]);
  await expect(page.getByRole('button', { name: 'Switch Auto-bid on' })).toBeDisabled();
  await page.clock.runFor(3 * 60_000);
  await expect.poll(() => calls.projects.length).toBeGreaterThan(1);
  expect(calls.bidsSent).toHaveLength(0);
});

test('switched on, it bids on the fresh in-house projects, logs them, and never twice', async ({
  page,
}) => {
  const calls = await open(page, { autobid: { minScore: 0 } });
  await expect(page.locator('#autobid-problems > li')).toHaveCount(0);
  await switchOn(page);

  await expect(bar(page)).toBeVisible();
  await expect(page.locator('#autobid-line')).toHaveText(
    /^Auto-bid on · last check \d\d:\d\d SAST · 2 placed today \/ cap 10$/,
  );
  expect(calls.bidsSent.map((b) => b.body.project_id).sort()).toEqual([RETAIL.id, AC.id].sort());
  const sent = Object.fromEntries(calls.bidsSent.map((b) => [b.body.project_id, b]));
  expect(sent[RETAIL.id]).toEqual({
    token: TOKEN,
    body: {
      project_id: RETAIL.id,
      bidder_id: 1234567,
      amount: 7500,
      period: 7,
      milestone_percentage: 100,
      description: `Hello. I can do ${RETAIL.title} for INR 7\u00a0500 in 7 days.`,
    },
  });
  expect(sent[AC.id]!.body).toMatchObject({ amount: 18, period: 7 });

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.log') ?? '[]'));
  expect(saved).toHaveLength(2);
  for (const entry of saved) {
    expect(entry).toMatchObject({ placedBy: 'auto', apiStatus: 200, status: 'sent' });
    expect(entry.freelancerBidId).toMatch(/^90000000\d$/);
  }
  await expect(page.locator('#autobid-activity > li')).toHaveCount(2);
  await expect(page.locator('#autobid-activity > li').first()).toContainText(
    'Placed automatically:',
  );

  // The Bids tab shows them, and can show only them.
  await page.getByRole('tab', { name: 'Bids' }).click();
  await page.getByLabel('Show').selectOption('auto');
  await expect(page.locator('#bid-list > li')).toHaveCount(2);
  await expect(page.locator('#bid-list > li').first()).toContainText('Placed automatically');

  // The next read, 90 seconds on, bids on neither again.
  const reads = calls.projects.length;
  await page.clock.runFor(90_000);
  await expect.poll(() => calls.projects.length).toBe(reads + 1);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('details.radar-autolog').first().locator('summary').click();
  // The feed hides projects already bid on, so the check sees the other four only.
  await expect(page.locator('#autobid-checked-note')).toContainText(
    '4 projects under 15 minutes old; 0 bid on.',
  );
  await expect(page.locator('#autobid-checked')).not.toContainText(RETAIL.title);
  await expect(page.locator('#autobid-checked')).not.toContainText(AC.title);
  expect(calls.bidsSent).toHaveLength(2);

  // Stop turns it off at once.
  await page.getByRole('button', { name: 'Stop Auto-bid' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('#status')).toHaveText(
    'Auto-bid is off. Nothing more is bid on by itself.',
  );
  await expect(page.locator('#autobid-state')).toHaveText('Auto-bid is off.');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('radar.autobid')!).on)).toBe(
    false,
  );
});

test('the daily cap holds: with a cap of 1, one bid today and the rest wait', async ({ page }) => {
  const calls = await open(page, { autobid: { minScore: 0, dailyCap: 1 } });
  await switchOn(page);
  await expect(page.locator('#autobid-line')).toContainText('1 placed today / cap 1');
  expect(calls.bidsSent).toHaveLength(1);
  await page.locator('details.radar-autolog').first().locator('summary').click();
  await expect(page.locator('#autobid-checked')).toContainText(
    'The daily cap is reached: 1 automatic bid today.',
  );
});

test('a rule nothing meets bids on nothing, and says why for each fresh project', async ({
  page,
}) => {
  const calls = await open(page, { autobid: { minScore: 100 } });
  await switchOn(page);
  await expect(page.locator('#autobid-line')).toContainText('0 placed today / cap 10');
  await page.locator('details.radar-autolog').first().locator('summary').click();
  await expect(page.locator('#autobid-checked-note')).toContainText(
    '6 projects under 15 minutes old; 0 bid on.',
  );
  await expect(page.locator('#autobid-checked')).toContainText('the lowest bid on is 100.');
  expect(calls.bidsSent).toHaveLength(0);
});

test('a refused bid is logged and shown, tried once more, then left alone', async ({ page }) => {
  const calls = await open(page, { autobid: { minScore: 0 }, bids: { refuse: 400 } });
  await switchOn(page);
  await expect.poll(() => calls.bidsSent.length).toBe(2);
  await expect(page.locator('#status')).toContainText('Auto-bid could not bid on');
  await page.clock.runFor(90_000);
  await expect.poll(() => calls.bidsSent.length).toBe(4);
  await page.clock.runFor(90_000);
  await page.locator('details.radar-autolog').first().locator('summary').click();
  await expect(page.locator('#autobid-checked')).toContainText(
    'Refused twice by Freelancer.com; not tried again.',
  );
  expect(calls.bidsSent).toHaveLength(4);
  expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
  await page.locator('details.radar-autolog').nth(1).locator('summary').click();
  await expect(page.locator('#autobid-activity > li')).toHaveCount(4);
  await expect(page.locator('#autobid-activity > li').first()).toContainText(
    'Freelancer.com refused placing the bid (HTTP 400: Refused in the e2e)',
  );
});

test('a refused token stops Auto-bid and says what to do', async ({ page }) => {
  await open(page, { autobid: { minScore: 0 }, bids: { refuse: 401 } });
  await switchOn(page);
  await expect(page.locator('#status')).toHaveText(
    'Auto-bid stopped: Token rejected (HTTP 401: Refused in the e2e). Generate a new one at accounts.freelancer.com/settings/develop.',
  );
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('#token-account')).toHaveText(
    'Token rejected (HTTP 401: Refused in the e2e). Generate a new one at accounts.freelancer.com/settings/develop.',
  );
  await expect(page.getByRole('button', { name: 'Switch Auto-bid on' })).toBeDisabled();
});

test('told to slow down (429), Auto-bid waits 15 minutes', async ({ page }) => {
  const calls = await open(page, { autobid: { minScore: 0 }, bids: { refuse: 429 } });
  await switchOn(page);
  await expect(page.locator('#status')).toContainText(
    'Freelancer.com asked Auto-bid to slow down (HTTP 429). It waits until',
  );
  expect(calls.bidsSent).toHaveLength(1);
  await expect(page.locator('#autobid-line')).toContainText('paused until');
  await page.clock.runFor(10 * 60_000);
  expect(calls.bidsSent).toHaveLength(1);
});

test('the Auto-bid settings and bar work at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page, { autobid: { minScore: 0 } });
  await switchOn(page);
  await expect(bar(page)).toBeVisible();
  await expectNoSidewaysScroll(page);
});
