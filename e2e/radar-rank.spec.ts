import { expect, test, type Page } from '@playwright/test';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * The rank score on the radar page (LI-PROMPT-BPOMAX-RADAR-20260927, 4.2): the feed is
 * sorted by it, the detail panel shows why, and the owner's in-house skills and weights
 * move it. The arithmetic itself is hand-worked in apps/web/src/radar/score.test.ts.
 */
const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;
const rows = (page: Page) => page.locator('#feed-list > li');

async function open(page: Page) {
  await page.clock.install({ time: NOW });
  await serveFreelancer(page);
  await page.goto('/radar.html');
  await expect(rows(page)).toHaveCount(ALL.length);
}

async function scores(page: Page) {
  return (await page.locator('#feed-list .radar-score').allTextContents()).map((text) =>
    Number.parseInt(text, 10),
  );
}

test('every row has a score, highest first', async ({ page }) => {
  await open(page);
  const list = await scores(page);
  expect(list).toHaveLength(ALL.length);
  for (const score of list) expect(score).toBeGreaterThanOrEqual(0);
  for (const score of list) expect(score).toBeLessThanOrEqual(100);
  expect(list).toEqual([...list].sort((a, b) => b - a));
});

test('the detail panel shows the score and each part of it', async ({ page }) => {
  await open(page);
  const first = rows(page).first();
  const score = Number.parseInt((await first.locator('.radar-score').textContent()) ?? '', 10);
  await first.locator('.radar-row__meta').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#detail-score')).toHaveText(`Rank score ${String(score)} of 100`);
  const parts = dialog.locator('#detail-parts tr');
  await expect(parts.locator('th')).toHaveText(['Skill fit', 'Budget', 'Freshness', 'Competition']);
  await expect(parts.locator('td.num')).toHaveText([
    /of 35,0$/,
    /of 25,0$/,
    /of 20,0$/,
    /of 20,0$/,
  ]);
  // Nothing is delivered in-house yet, so skill fit gives nothing.
  await expect(parts.first().locator('td.num')).toHaveText('0,0 of 35,0');
  const sum = (await parts.locator('td.num').allTextContents())
    .map((t) => Number(t.split(' of ')[0]!.replace(',', '.')))
    .reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - score)).toBeLessThanOrEqual(0.5 + 0.2);
});

test('an in-house skill lifts the projects that need it', async ({ page }) => {
  await open(page);
  const project = ALL.find((p) => p.jobs.length >= 2)!;
  const skill = project.jobs[0]!.name;
  const before = Number.parseInt(
    (await rows(page)
      .filter({ hasText: project.title })
      .first()
      .locator('.radar-score')
      .textContent()) ?? '',
    10,
  );

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Find an in-house skill').fill(skill);
  await page.getByRole('checkbox', { name: skill, exact: true }).check();
  await expect(page.locator('#inhouse-chosen')).toContainText(skill);

  await page.getByRole('tab', { name: 'Feed' }).click();
  const row = rows(page).filter({ hasText: project.title }).first();
  const after = Number.parseInt((await row.locator('.radar-score').textContent()) ?? '', 10);
  expect(after).toBeGreaterThan(before);
  await row.locator('.radar-row__meta').click();
  await expect(page.locator('#detail-parts tr').first().locator('td').last()).toHaveText(
    `1 of ${String(project.jobs.length)} skills delivered in-house`,
  );

  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#inhouse-chosen')).toContainText(skill);
});

test('the weights are the owner’s, checked, saved and applied', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Skill fit')).toHaveValue('35');
  await expect(page.getByLabel('Budget', { exact: true })).toHaveValue('25');
  await expect(page.getByLabel('Freshness')).toHaveValue('20');
  await expect(page.getByLabel('Competition')).toHaveValue('20');

  await page.getByLabel('Skill fit').fill('0');
  await page.getByLabel('Budget', { exact: true }).fill('0');
  await page.getByLabel('Freshness').fill('0');
  await page.getByLabel('Competition').fill('150');
  await expect(page.locator('#settings-error')).toHaveText(
    'Enter a whole number from 0 to 100 in: Competition.',
  );
  await page.getByLabel('Competition').fill('10');
  await expect(page.locator('#settings-error')).toBeHidden();

  // Competition alone: a project with no bids scores 100, one with 25 scores 50.
  await page.getByRole('tab', { name: 'Feed' }).click();
  const unbid = ALL.filter((p) => p.bid_stats.bid_count === 0).length;
  expect(unbid).toBeGreaterThan(0);
  const list = await scores(page);
  expect(list.filter((s) => s === 100)).toHaveLength(unbid);
  const some = ALL.find((p) => p.bid_stats.bid_count > 0 && p.bid_stats.bid_count < 50)!;
  await expect(
    rows(page).filter({ hasText: some.title }).first().locator('.radar-score'),
  ).toHaveText(`${String(Math.round(100 - 2 * some.bid_stats.bid_count))} out of 100`);

  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Competition')).toHaveValue('10');
});
