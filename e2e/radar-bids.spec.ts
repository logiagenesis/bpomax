import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, serveFreelancer } from './radar-helpers.js';

/**
 * The Bids tab (LI-PROMPT-BPOMAX-RADAR-20260927, 4.5): status buttons, award figures, the
 * totals and their splits, and Export / Import. The figures' arithmetic is hand-worked in
 * apps/web/src/radar/tracker.test.ts; here the page shows what it computes.
 */
const NOW = NEWEST + 5 * 60_000; // 27/09/2026 08:53 SAST
const NB = ' ';

function entry(n: number, over: Record<string, unknown>) {
  return {
    id: `bid-${String(n)}`,
    projectId: 900 + n,
    title: `Logged project ${String(n)}`,
    url: `https://www.freelancer.com/projects/logged/p${String(n)}`,
    skills: ['PHP'],
    budget: { min: 100, max: 1000 },
    type: 'fixed',
    currency: 'USD',
    usdRate: 1,
    price: 450,
    days: 7,
    templateId: 't1',
    templateName: 'Short',
    proposal: 'Hello.',
    score: 75,
    scoreParts: { skill: 35, budget: 10, fresh: 20, competition: 10 },
    bidCount: 3,
    ageMinutes: 12,
    status: 'sent',
    replied: false,
    award: null,
    ...over,
  };
}

// Newest first: two this month (SAST), one in August.
const LOG = [
  entry(1, { placedAt: '2026-09-20T08:00:00.000Z' }),
  entry(2, {
    placedAt: '2026-09-15T08:00:00.000Z',
    currency: 'INR',
    usdRate: 0.010436,
    price: 7500,
    score: 50,
  }),
  entry(3, {
    placedAt: '2026-08-10T08:00:00.000Z',
    currency: 'AUD',
    usdRate: 0.7,
    price: 1800,
    score: 30,
    templateId: null,
    templateName: null,
  }),
];

async function open(page: Page, seedLog: unknown[] | null = LOG) {
  if (seedLog) {
    await page.addInitScript((log) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('radar.log', JSON.stringify(log));
    }, seedLog);
  }
  await page.clock.install({ time: NOW });
  await serveFreelancer(page);
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  await page.getByRole('tab', { name: 'Bids' }).click();
}

const card = (page: Page, title: string) =>
  page.locator('#totals > section').filter({ has: page.getByRole('heading', { name: title }) });

async function figures(page: Page, title: string) {
  const dl = card(page, title).locator('dl');
  const names = await dl.locator('dt').allTextContents();
  const values = await dl.locator('dd').allTextContents();
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

const item = (page: Page, n: number) => page.locator(`#bid-list > li[data-bid="bid-${String(n)}"]`);

test('lists every logged bid, newest first, with totals for this month and all time', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#bid-list > li h3')).toHaveText([
    'Logged project 1',
    'Logged project 2',
    'Logged project 3',
  ]);
  await expect(item(page, 1).locator('.radar-row__meta')).toHaveText(
    'Placed 20/09/2026 10:00 SAST · USD 450 · 7 days · template Short · score 75 · no reply yet',
  );
  await expect(item(page, 1).getByRole('link', { name: 'Logged project 1' })).toHaveAttribute(
    'href',
    'https://www.freelancer.com/projects/logged/p1',
  );
  expect(await figures(page, 'This month')).toEqual({
    Bids: '2',
    Replies: '0',
    'Reply rate': '0,0% (0 of 2)',
    Awards: '0',
    'Win rate (awards ÷ replies)': 'No data (0 of 0)',
    'Awarded value': 'USD 0,00',
    'Delivery cost': 'USD 0,00',
    Margin: 'USD 0,00 (fee not set)',
  });
  expect((await figures(page, 'All time'))['Bids']).toBe('3');
});

test('status buttons, the award’s figures, the fee and the rand rate', async ({ page }) => {
  await open(page);
  await item(page, 1).getByRole('button', { name: 'Awarded' }).click();
  await expect(page.locator('#status')).toHaveText('“Logged project 1” is marked awarded.');
  await expect(item(page, 1).locator('.badge')).toHaveText('Awarded');
  await expect(item(page, 1).getByRole('button', { name: 'Awarded' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(item(page, 1).getByLabel('Agreed value (USD)')).toHaveValue('450');
  await expect(item(page, 1).getByLabel('Delivery cost (USD)')).toHaveValue('0');

  await item(page, 1).getByLabel('Delivery cost (USD)').fill('120');
  await item(page, 1).getByLabel('Note').fill('Delivered by the in-house team lead.');
  await expect(item(page, 1).locator('.field__hint').last()).toHaveText(
    'Awarded USD 450,00. Margin USD 330,00 (fee not set).',
  );
  expect(await figures(page, 'This month')).toMatchObject({
    Replies: '1',
    'Reply rate': '50,0% (1 of 2)',
    Awards: '1',
    'Win rate (awards ÷ replies)': '100,0% (1 of 1)',
    'Awarded value': 'USD 450,00',
    'Delivery cost': 'USD 120,00',
    Margin: 'USD 330,00 (fee not set)',
  });

  await item(page, 3).getByRole('button', { name: 'Replied' }).click();
  await item(page, 2).getByRole('button', { name: 'Lost' }).click();
  await expect(item(page, 2).locator('.radar-row__meta')).toContainText('no reply yet');
  expect(await figures(page, 'This month')).toMatchObject({ Replies: '1' });
  expect(await figures(page, 'All time')).toMatchObject({
    Replies: '2',
    'Reply rate': '66,7% (2 of 3)',
    'Win rate (awards ÷ replies)': '50,0% (1 of 2)',
  });
  await item(page, 3).getByRole('button', { name: 'No reply' }).click();
  await item(page, 2).getByRole('button', { name: 'Back to sent' }).click();
  await expect(item(page, 2).locator('.badge')).toHaveText('Sent');
  expect(await figures(page, 'All time')).toMatchObject({ Replies: '1' });

  // The split tables: by template (Short, No template) and by rank band.
  const month = page.locator('#splits-month-body');
  await expect(month.locator('table').first().locator('tbody th')).toHaveText(['Short']);
  await expect(month.locator('table').nth(1).locator('tbody th')).toHaveText([
    '0–39',
    '40–69',
    '70–100',
  ]);
  await expect(month.locator('table').nth(1).locator('tbody tr').nth(2).locator('td')).toHaveText([
    '1',
    '1',
    '100,0% (1 of 1)',
    '1',
    '100,0% (1 of 1)',
  ]);
  await page.locator('#splits-all > summary').click();
  await expect(page.locator('#splits-all-body table').first().locator('tbody th')).toHaveText([
    'Short',
    'No template',
  ]);

  // A fee and a rand rate from settings.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Freelancer.com’s fee on an award, %').fill('10');
  await page.getByLabel('Rand for one US dollar').fill('18');
  await page.getByRole('tab', { name: 'Bids' }).click();
  expect(await figures(page, 'This month')).toMatchObject({
    'Awarded value': `USD 450,00 · R8${NB}100,00`,
    'Delivery cost': `USD 120,00 · R2${NB}160,00`,
    Margin: `USD 285,00 · R5${NB}130,00 after fees of USD 45,00`,
  });
  await expect(item(page, 1).locator('.field__hint').last()).toHaveText(
    `Awarded USD 450,00. Margin USD 285,00 · R5${NB}130,00 after a 10 % fee of USD 45,00.`,
  );

  // All of it survives a reload.
  await page.reload();
  await page.getByRole('tab', { name: 'Bids' }).click();
  await expect(item(page, 1).getByLabel('Delivery cost (USD)')).toHaveValue('120');
  await expect(item(page, 1).getByLabel('Note')).toHaveValue(
    'Delivered by the in-house team lead.',
  );
  expect((await figures(page, 'This month'))['Margin']).toBe(
    `USD 285,00 · R5${NB}130,00 after fees of USD 45,00`,
  );
});

test('an award’s figures must be numbers', async ({ page }) => {
  await open(page);
  await item(page, 2).getByRole('button', { name: 'Awarded' }).click();
  await expect(item(page, 2).getByLabel('Agreed value (INR)')).toHaveValue('7500');
  await item(page, 2).getByLabel('Agreed value (INR)').fill('lots');
  await expect(item(page, 2).locator('.field__error')).toHaveText(
    'Enter the agreed value and the delivery cost as numbers (0 for in-house).',
  );
  await item(page, 2).getByLabel('Agreed value (INR)').fill('10000');
  await expect(item(page, 2).locator('.field__error')).toBeHidden();
  // INR 10 000 × 0,010436 = USD 104,36.
  expect((await figures(page, 'This month'))['Awarded value']).toBe('USD 104,36');
});

test('Export downloads everything; Import puts it back after a confirm', async ({
  page,
  browser,
}) => {
  await open(page);
  await item(page, 1).getByRole('button', { name: 'Replied' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('radar-backup-27-09-2026.json');
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  const backup = JSON.parse(text);
  const file = {
    name: 'radar-backup-27-09-2026.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  };
  expect(backup).toMatchObject({ format: 'radar-backup', version: 1 });
  expect(Object.keys(backup).sort()).toEqual(
    [
      'dismissed',
      'exportedAt',
      'format',
      'log',
      'settings',
      'shortlist',
      'templates',
      'version',
    ].sort(),
  );
  expect(backup.log).toHaveLength(3);
  expect(backup.log[0].status).toBe('replied');
  await expect(page.locator('#status')).toHaveText(
    'Exported everything to radar-backup-27-09-2026.json. Keep it somewhere safe.',
  );

  // A fresh browser with nothing in it.
  const fresh = await (await browser.newContext()).newPage();
  await open(fresh, null);
  await expect(fresh.locator('#bids-empty')).toContainText('No bids logged yet.');

  await fresh.locator('#import-file').setInputFiles({
    name: 'not-a-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"hello":1}'),
  });
  await expect(fresh.locator('#status')).toHaveText('That file is not a radar backup.');

  await fresh.locator('#import-file').setInputFiles(file);
  const confirm = fresh.getByRole('dialog');
  await expect(confirm).toContainText('with 3 logged bids');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(fresh.locator('#status')).toHaveText('Nothing was imported.');
  await expect(fresh.locator('#bid-list > li')).toHaveCount(0);

  await fresh.locator('#import-file').setInputFiles(file);
  await fresh.getByRole('dialog').getByRole('button', { name: 'Replace' }).click();
  await expect(fresh.locator('#status')).toHaveText(
    /^Imported radar-backup-27-09-2026\.json, exported 27\/09\/2026 \d{2}:\d{2} SAST\.$/,
  );
  await fresh.getByRole('tab', { name: 'Bids' }).click();
  await expect(fresh.locator('#bid-list > li')).toHaveCount(3);
  await expect(fresh.locator('#bid-list > li').first().locator('.badge')).toHaveText('Replied');
  await expect(fresh.locator('#bid-counter')).toHaveText(
    'Bids logged in this browser this month: 2',
  );
});

test('the Bids tab works at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await item(page, 1).getByRole('button', { name: 'Awarded' }).click();
  await page.locator('#splits-all > summary').click();
  await expectNoSidewaysScroll(page);
});
