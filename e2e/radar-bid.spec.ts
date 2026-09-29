import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Templates, the proposal, the price and Bid on Freelancer (LI-PROMPT-BPOMAX-RADAR-20260927,
 * 4.3–4.4). Nothing is submitted anywhere: the page copies the proposal, opens the project
 * in a new tab (answered here), and logs the bid only when the owner says it was placed.
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;
const RECRUITER = ALL.find((p) => p.title === 'IT Recruiter for Interviews')!; // USD 250–750
const BOAT = ALL.find((p) => p.title === 'Recreational Motorboat Design')!; // AUD 3 000–5 000
const PINS = ALL.find((p) => p.title === 'Vibrant Product Pinterest Pins')!; // USD 15–25/h
const rows = (page: Page) => page.locator('#feed-list > li');
const row = (page: Page, title: string) => rows(page).filter({ hasText: title }).first();

const TEMPLATE = {
  id: 'tpl-1',
  name: 'Short',
  body: 'Hello. About {title}: {first_line}\nI can do this for {price} in {timeline_days} days ({budget}). Skills: {skills}.',
  isDefault: true,
};

/**
 * Every skill of the three projects these specs bid on, ticked as delivered in-house, so the
 * template's `{skills}` has something to fill it. Without one, the page refuses to copy or
 * place the bid (radar-safety.spec.ts).
 */
const IN_HOUSE = [
  ...new Map(
    [RECRUITER, BOAT, PINS].flatMap((p) => p.jobs.map((j) => [j.id, { id: j.id, name: j.name }])),
  ).values(),
];

/** Puts templates and settings in the browser before the page loads, once per tab. */
async function seed(page: Page, templates: unknown[], settings: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([t, s]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('radar.templates', JSON.stringify(t));
      localStorage.setItem('radar.settings', JSON.stringify(s));
    },
    [templates, settings] as const,
  );
}

async function open(page: Page) {
  await page.clock.install({ time: NOW });
  await serveFreelancer(page);
  await page.goto('/radar.html');
  await expect(rows(page)).toHaveCount(ALL.length);
}

async function detailOf(page: Page, title: string) {
  await row(page, title).locator('.radar-row__meta').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(title);
  return dialog;
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test('with no template the detail panel says to add one, and takes you there', async ({ page }) => {
  await open(page);
  const dialog = await detailOf(page, RECRUITER.title);
  await expect(dialog.locator('#p-empty')).toContainText('Add your first template');
  await expect(dialog.getByRole('button', { name: 'Bid on Freelancer' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Add a template' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Templates' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Name')).toBeFocused();
  await expect(page.locator('#templates-empty')).toContainText('Add your first template');
  await expect(page.locator('#placeholders dt')).toHaveText([
    '{title}',
    '{skills}',
    '{budget}',
    '{price}',
    '{timeline_days}',
    '{first_line}',
  ]);
});

test('templates are added, checked, edited, made default and deleted', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Templates' }).click();
  const form = page.locator('#template-form');

  await form.getByRole('button', { name: 'Add the template' }).click();
  await expect(page.locator('#t-name-error')).toHaveText('Give the template a name.');
  await expect(page.locator('#t-body-error')).toHaveText('Write the text of the template.');

  await page.getByLabel('Name').fill('First');
  await page.getByLabel('Text', { exact: true }).fill('One {title}');
  await form.getByRole('button', { name: 'Add the template' }).click();
  await expect(page.locator('#status')).toHaveText('Added “First”.');
  await expect(page.locator('#templates-empty')).toBeHidden();

  await page.getByLabel('Name').fill('first');
  await page.getByLabel('Text', { exact: true }).fill('Two');
  await form.getByRole('button', { name: 'Add the template' }).click();
  await expect(page.locator('#t-name-error')).toHaveText('Another template has this name.');
  await page.getByLabel('Name').fill('Second');
  await form.getByRole('button', { name: 'Add the template' }).click();

  const list = page.locator('#template-list > li');
  await expect(list).toHaveCount(2);
  // The first template added is the default until another is chosen.
  await expect(list.nth(0).locator('.badge')).toHaveText('Default');
  await page.getByRole('button', { name: 'Make default: Second' }).click();
  await expect(page.locator('#status')).toHaveText('“Second” is now the default template.');
  await expect(list.nth(1).locator('.badge')).toHaveText('Default');
  await expect(list.nth(0).locator('.badge')).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit: First' }).click();
  await expect(page.locator('#template-heading')).toHaveText('Edit “First”');
  await page.getByLabel('Text', { exact: true }).fill('One, changed {price}');
  await form.getByRole('button', { name: 'Save the template' }).click();
  await expect(page.locator('#status')).toHaveText('Saved “First”.');
  await expect(list.nth(0)).toContainText('One, changed {price}');

  await page.getByRole('button', { name: 'Edit: Second' }).click();
  await page.getByRole('button', { name: 'Cancel editing' }).click();
  await expect(page.locator('#template-heading')).toHaveText('Add a template');
  await expect(page.getByLabel('Name')).toHaveValue('');

  await page.reload();
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(list).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete: First' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(list).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete: First' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#status')).toHaveText('Deleted “First”.');
  await expect(list).toHaveCount(1);
});

test('Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it', async ({
  page,
}) => {
  await seed(page, [TEMPLATE], {
    inHouse: [{ id: RECRUITER.jobs[0]!.id, name: RECRUITER.jobs[0]!.name }],
    monthlyLimit: 300,
  });
  await open(page);
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 0 / 300');
  const dialog = await detailOf(page, RECRUITER.title);

  // 60 % of USD 750 is USD 450, within 250–750.
  await expect(dialog.getByLabel('Price (USD)')).toHaveValue('450');
  await expect(dialog.locator('#p-price-hint')).toHaveText('The client’s budget: USD 250–750.');
  await expect(dialog.getByLabel('Delivery days')).toHaveValue('7');
  await expect(dialog.getByLabel('Template')).toHaveValue('tpl-1');
  // This description's first sentence runs past 160 characters, so `{first_line}` is cut at
  // the last whole word before the 160th ("…funnel now" – the next word, "needs", would
  // have been cut through) and ends with …
  const firstSentence =
    'Our growing IT services company is expanding headcount across engineering, product, sales, and operations, and the interview stage of the hiring funnel now…';
  expect(RECRUITER.description).toContain(`${firstSentence.slice(0, -1)} need`);
  expect(firstSentence.length).toBeLessThanOrEqual(161);
  const expected = `Hello. About ${RECRUITER.title}: ${firstSentence}\nI can do this for USD 450 in 7 days (USD 250–750). Skills: ${RECRUITER.jobs[0]!.name}.`;
  await expect(dialog.getByLabel('Proposal')).toHaveValue(expected);
  await expect(dialog.locator('#p-count')).toHaveText(`${String(expected.length)} characters`);

  // The owner edits the text; the count follows.
  await dialog.getByLabel('Proposal').fill(`${expected}\nThanks.`);
  await expect(dialog.locator('#p-count')).toHaveText(`${String(expected.length + 8)} characters`);

  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  expect((await popup).url()).toBe(`https://www.freelancer.com/projects/${RECRUITER.seo_url}`);
  expect(await clipboard(page)).toBe(`${expected}\nThanks.`);
  await expect(dialog.locator('#detail-status')).toHaveText(
    'Proposal copied. Paste it into your bid on Freelancer.com.',
  );
  await expect(dialog.locator('#bid-price-line')).toHaveText('Price to enter: USD 450 · Days: 7');
  await expect(dialog.getByRole('link', { name: 'Open it on Freelancer.com' })).toHaveAttribute(
    'href',
    `https://www.freelancer.com/projects/${RECRUITER.seo_url}`,
  );

  await dialog.getByRole('button', { name: 'Copy price' }).click();
  await expect(dialog.locator('#detail-status')).toHaveText('Price 450 copied.');
  expect(await clipboard(page)).toBe('450');

  await dialog.getByRole('button', { name: 'I placed the bid' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#status')).toHaveText(`Logged your bid on “${RECRUITER.title}”.`);
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 1 / 300');
  await expect(rows(page)).toHaveCount(ALL.length - 1);
  await expect(row(page, RECRUITER.title)).toHaveCount(0);

  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.log') ?? '[]'));
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    projectId: RECRUITER.id,
    title: RECRUITER.title,
    url: `https://www.freelancer.com/projects/${RECRUITER.seo_url}`,
    skills: RECRUITER.jobs.map((j) => j.name),
    budget: { min: 250, max: 750 },
    currency: 'USD',
    usdRate: 1,
    price: 450,
    days: 7,
    templateId: 'tpl-1',
    templateName: 'Short',
    proposal: `${expected}\nThanks.`,
    bidCount: RECRUITER.bid_stats.bid_count,
    status: 'sent',
  });
  expect(log[0].score).toBeGreaterThan(0);
  expect(Object.keys(log[0].scoreParts)).toEqual(['skill', 'budget', 'fresh', 'competition']);
  expect(Date.parse(log[0].placedAt) - NOW).toBeGreaterThanOrEqual(0);
  expect(Date.parse(log[0].placedAt) - NOW).toBeLessThan(60_000);

  // Still logged after a reload; shown as Bid placed when acted-on projects are not hidden.
  await page.reload();
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 1 / 300');
  await page.locator('#filters-box > summary').click();
  await page.getByLabel('Hide projects already bid on or dismissed').uncheck();
  await expect(row(page, RECRUITER.title).locator('.badge')).toContainText(['Bid placed']);
  const again = await detailOf(page, RECRUITER.title);
  await expect(again.locator('#bid-placed')).toHaveText(
    /^You logged a bid on this project on \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} SAST\.$/,
  );
});

test('Cancel logs nothing', async ({ page }) => {
  await seed(page, [TEMPLATE], { inHouse: IN_HOUSE });
  await open(page);
  const dialog = await detailOf(page, RECRUITER.title);
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  await popup;
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.locator('#bid-panel')).toBeHidden();
  await expect(dialog.locator('#detail-status')).toHaveText('Nothing was logged.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(rows(page)).toHaveCount(ALL.length);
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 0');
  expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
});

test('when the clipboard refuses, the text is selected to copy by hand', async ({ page }) => {
  await seed(page, [TEMPLATE], { inHouse: IN_HOUSE });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  await open(page);
  const dialog = await detailOf(page, RECRUITER.title);
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  await popup;
  await expect(dialog.locator('#detail-status')).toHaveText('Copy failed — press Ctrl+C');
  const selected = await page.evaluate(() => {
    const box = document.getElementById('p-text') as HTMLTextAreaElement;
    return box.value.slice(box.selectionStart, box.selectionEnd);
  });
  expect(selected).toBe(await dialog.getByLabel('Proposal').inputValue());
  await expect(dialog.locator('#bid-panel')).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy price' }).click();
  await expect(dialog.locator('#detail-status')).toHaveText('Copy failed — the price is 450.');
});

test('the price is the owner’s to change, shown in USD too, and checked', async ({ page }) => {
  await seed(page, [TEMPLATE], { pricePct: 70, defaultDays: 12, inHouse: IN_HOUSE });
  await open(page);
  // 70 % of AUD 5 000 is 3 500, within 3 000–5 000.
  let dialog = await detailOf(page, BOAT.title);
  await expect(dialog.getByLabel('Price (AUD)')).toHaveValue('3500');
  const usd = Math.round(3500 * BOAT.currency.exchange_rate);
  await expect(dialog.locator('#p-price-hint')).toHaveText(
    `The client’s budget: AUD 3\u00a0000–5\u00a0000. Your price is about USD ${String(usd).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}.`,
  );
  await expect(dialog.getByLabel('Delivery days')).toHaveValue('12');
  await dialog.getByLabel('Price (AUD)').fill('3200,50');
  await expect(dialog.getByLabel('Proposal')).toHaveValue(/for AUD 3\u00a0200,50 in 12 days/);
  await dialog.getByLabel('Delivery days').fill('9');
  await expect(dialog.getByLabel('Proposal')).toHaveValue(/for AUD 3\u00a0200,50 in 9 days/);

  await dialog.getByLabel('Price (AUD)').fill('');
  await dialog.getByLabel('Delivery days').fill('0');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  // With the price blank the text still has {price} in it, which the page refuses too.
  await expect(dialog.locator('#p-error')).toHaveText(
    'Enter your price, a number above 0. Enter the delivery days, a whole number from 1 to 365. Fill or remove {price} before bidding.',
  );
  await expect(dialog.locator('#bid-panel')).toBeHidden();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Hourly: the price is per hour (70 % of USD 25 is 17,5 → 18).
  dialog = await detailOf(page, PINS.title);
  await expect(dialog.getByLabel('Price per hour (USD)')).toHaveValue('18');
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  await popup;
  await expect(dialog.locator('#bid-price-line')).toHaveText(
    'Price to enter: USD 18 per hour · Days: 12',
  );
});

test('bidding settings are checked and saved; a blank limit shows no limit', async ({ page }) => {
  await open(page);
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 0');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Opening price, % of the project’s maximum')).toHaveValue('60');
  await expect(page.getByLabel('Delivery days, unless you change them')).toHaveValue('7');
  await page.getByLabel('Bids your membership allows a month').fill('50');
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 0 / 50');
  await page.getByLabel('Opening price, % of the project’s maximum').fill('0');
  await page.getByLabel('Delivery days, unless you change them').fill('3,5');
  await expect(page.locator('#settings-error')).toHaveText(
    'Opening price, % of the project’s maximum: a whole number from 1 to 100. Delivery days, unless you change them: a whole number from 1 to 365.',
  );
  await page.getByLabel('Opening price, % of the project’s maximum').fill('55');
  await page.getByLabel('Delivery days, unless you change them').fill('5');
  await expect(page.locator('#settings-error')).toBeHidden();
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Opening price, % of the project’s maximum')).toHaveValue('55');
  await expect(page.getByLabel('Bids your membership allows a month')).toHaveValue('50');
  await page.getByLabel('Bids your membership allows a month').fill('');
  await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 0');
});

test('the bid panel works at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await seed(page, [TEMPLATE], { inHouse: IN_HOUSE });
  await open(page);
  const dialog = await detailOf(page, RECRUITER.title);
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
  await popup;
  await expect(dialog.locator('#bid-panel')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expectNoSidewaysScroll(page);
});
