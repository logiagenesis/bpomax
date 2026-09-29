import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * The page says what is live and what is not (LI-PROMPT-BPOMAX-FIX-20260929, batch 2): no
 * way from Radar to sample data without a "Demo" label (R-05), a setup line (U-01), the
 * export reminder (U-02), and a rank breakdown that names an empty setting (U-03). The
 * arithmetic of the age rule is hand-worked in apps/web/src/radar/setup.test.ts.
 */
const NOW = NEWEST + 5 * 60_000; // 27/09/2026 08:53 SAST
const DAY = 24 * 60 * 60 * 1000;
const ALL = PROJECTS.result.projects;
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

interface Seed {
  templates?: unknown[];
  settings?: Record<string, unknown>;
  lastExport?: number;
  token?: { savedAt: number; problem?: string | null };
}

/** Puts the owner's state in the browser before the page loads, once per tab. */
async function open(page: Page, seed: Seed = {}) {
  const stored = seed.token
    ? {
        token: TOKEN,
        savedAt: seed.token.savedAt,
        account: ACCOUNT,
        checkedAt: seed.token.savedAt,
        problem: seed.token.problem ?? null,
      }
    : null;
  await page.addInitScript(
    ([templates, settings, lastExport, token]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      if (templates) localStorage.setItem('radar.templates', JSON.stringify(templates));
      if (settings) localStorage.setItem('radar.settings', JSON.stringify(settings));
      if (lastExport !== null) localStorage.setItem('radar.lastExport', JSON.stringify(lastExport));
      if (token) localStorage.setItem('radar.token', JSON.stringify(token));
    },
    [seed.templates ?? null, seed.settings ?? null, seed.lastExport ?? null, stored] as const,
  );
  await page.clock.install({ time: NOW });
  await serveFreelancer(page);
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
}

const setup = (page: Page) => page.locator('#setup > li');
const item = (page: Page, key: string) => page.locator(`#setup > li[data-item="${key}"]`);

test.describe('R-05: no way to sample data without a Demo label', () => {
  test('the header links nowhere, and no link on the page reaches another app page unlabelled', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator('header a')).toHaveCount(0);
    await expect(page.locator('header nav')).toHaveCount(0);
    await expect(page.locator('header')).toContainText('Arbitron');

    const links = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.map((a) => ({
        url: (a as HTMLAnchorElement).href,
        text: (a.textContent ?? '').trim(),
      })),
    );
    const here = new URL(page.url());
    const toOtherAppPages = links.filter((link) => {
      const url = new URL(link.url);
      return url.origin === here.origin && url.pathname !== here.pathname;
    });
    for (const link of toOtherAppPages) expect(link.text).toMatch(/^Demo/);
    // What is left on the page goes to Freelancer.com only.
    expect(links.length).toBeGreaterThan(0);
    for (const link of links.filter((l) => !toOtherAppPages.includes(l))) {
      expect(new URL(link.url).origin).toMatch(/^https:\/\/(www|accounts)\.freelancer\.com$/);
    }
  });
});

test.describe('U-01: the setup line', () => {
  test('on fresh storage every item is not set, in order, and browsing is not blocked', async ({
    page,
  }) => {
    await open(page);
    await expect(setup(page)).toHaveText([
      'Skills: not set',
      'In-house ticks: not set',
      'Template: not set',
      'Monthly limit: not set',
      'Fee %: not set',
      'USD→ZAR: not set',
      'Token: not saved',
      'Last export: never',
    ]);
    for (const li of await setup(page).all())
      await expect(li).toHaveAttribute('data-state', 'unset');
    // Nothing is blocked: the feed lists the projects and the tabs open.
    await expect(page.locator('#feed-list > li')).toHaveCount(ALL.length);
    await page.getByRole('tab', { name: 'Bids' }).click();
    await expect(page.locator('#panel-bids')).toBeVisible();
  });

  test('each item turns to set as it is set, and stays so after a reload', async ({ page }) => {
    await open(page);
    const skill = ALL.find((p) => p.jobs.length >= 2)!.jobs[0]!.name;

    await page.getByRole('tab', { name: 'Templates' }).click();
    await page.getByLabel('Name').fill('Short');
    await page.getByLabel('Text', { exact: true }).fill('Hello about {title}.');
    await page.getByRole('button', { name: 'Add the template' }).click();
    await expect(item(page, 'template')).toHaveText('Template: set');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Bids your membership allows a month').fill('100');
    await page.getByLabel('Rand for one US dollar').fill('16,50');
    await page.getByLabel('Freelancer.com’s fee on an award, %').fill('10');
    await page.getByLabel('Find an in-house skill').fill(skill);
    await page
      .locator('#inhouse-matches')
      .getByRole('checkbox', { name: skill, exact: true })
      .check();
    await page.getByLabel('Find a skill', { exact: true }).fill(skill);
    await page
      .locator('#watch-matches')
      .getByRole('checkbox', { name: skill, exact: true })
      .check();

    const expected = [
      'Skills: set',
      'In-house ticks: set',
      'Template: set',
      'Monthly limit: set',
      'Fee %: set',
      'USD→ZAR: set',
      'Token: not saved',
      'Last export: never',
    ];
    await expect(setup(page)).toHaveText(expected);
    await expect(item(page, 'token')).toHaveAttribute('data-state', 'unset');

    await page.reload();
    await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
    await expect(setup(page)).toHaveText(expected);

    // Clearing a blank-able setting puts it back to not set.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Bids your membership allows a month').fill('');
    await expect(item(page, 'limit')).toHaveText('Monthly limit: not set');
  });

  test('a token accepted at its last check, with days to run, shows as saved', async ({ page }) => {
    await open(page, { token: { savedAt: NOW - 2 * DAY } });
    await expect(item(page, 'token')).toHaveText('Token: saved');
    await expect(item(page, 'token')).toHaveAttribute('data-state', 'set');
  });

  for (const [days, problem, text, state] of [
    [26, null, 'Token: expiring', 'warn'],
    [31, null, 'Token: expired', 'warn'],
    [2, 'Token rejected (HTTP 401).', 'Token: refused', 'warn'],
  ] as const) {
    test(`a token saved ${String(days)} days ago${problem ? ', refused at its last check,' : ''} shows as “${text}”`, async ({
      page,
    }) => {
      await open(page, { token: { savedAt: NOW - days * DAY, problem } });
      await expect(item(page, 'token')).toHaveText(text);
      await expect(item(page, 'token')).toHaveAttribute('data-state', state);
    });
  }

  test('works at 380 px wide: the eight items wrap and nothing scrolls sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await open(page);
    await expect(setup(page)).toHaveCount(8);
    await expectNoSidewaysScroll(page);
    for (const li of await setup(page).all()) await expect(li).toBeVisible();
  });
});

test.describe('U-02: the export reminder', () => {
  const TEMPLATE = { id: 't1', name: 'Short', body: 'Hello about {title}.', isDefault: true };
  const KEEP = 'What you save here stays only in this browser: press Export to keep a copy.';

  test('a first visit shows Never exported and does not nag when nothing is saved', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator('#export-note')).toHaveText('Never exported');
    await expect(page.locator('#export-warning')).toBeHidden();
  });

  test('never exported, with something saved, warns', async ({ page }) => {
    await open(page, { templates: [TEMPLATE] });
    await expect(page.locator('#export-note')).toHaveText('Never exported');
    await expect(page.locator('#export-warning')).toHaveText(`You have not exported yet. ${KEEP}`);
  });

  test('up to 7 days ago there is no warning; after, there is', async ({ page, browser }) => {
    // Just under 7 days before NOW, which is still 20/09/2026 in SAST. (The clock keeps
    // running once installed, so exactly 7 days would tip over; setup.test.ts pins the exact
    // boundary: 7 days is fine, 7 days and 1 ms is not.)
    await open(page, { templates: [TEMPLATE], lastExport: NOW - 7 * DAY + 5 * 60_000 });
    await expect(page.locator('#export-note')).toHaveText('Last export: 20/09/2026');
    await expect(page.locator('#export-warning')).toBeHidden();
    await expect(item(page, 'export')).toHaveText('Last export: 20/09/2026');
    await expect(item(page, 'export')).toHaveAttribute('data-state', 'set');

    const late = await (await browser.newContext()).newPage();
    await open(late, { templates: [TEMPLATE], lastExport: NOW - 8 * DAY });
    await expect(late.locator('#export-note')).toHaveText('Last export: 19/09/2026');
    await expect(late.locator('#export-warning')).toHaveText(
      `Your last export was 8 days ago (19/09/2026). ${KEEP}`,
    );
    await expect(item(late, 'export')).toHaveAttribute('data-state', 'warn');
  });

  test('Export records the time, clears the warning, and still leaves the token out', async ({
    page,
  }) => {
    await open(page, {
      templates: [TEMPLATE],
      lastExport: NOW - 9 * DAY,
      token: { savedAt: NOW - DAY },
    });
    await expect(page.locator('#export-warning')).toBeVisible();

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const text = await readFile((await (await downloading).path()) ?? '', 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('lastExport');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
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

    await expect(page.locator('#export-note')).toHaveText('Last export: 27/09/2026');
    await expect(page.locator('#export-warning')).toBeHidden();
    await expect(item(page, 'export')).toHaveText('Last export: 27/09/2026');
    const saved = await page.evaluate(() => Number(localStorage.getItem('radar.lastExport')));
    expect(saved).toBeGreaterThanOrEqual(NOW);
    expect(saved).toBeLessThan(NOW + 60_000);

    await page.reload();
    await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
    await expect(page.locator('#export-note')).toHaveText('Last export: 27/09/2026');
  });
});

test.describe('U-03: the rank breakdown names an empty setting', () => {
  const project = ALL.find((p) => p.jobs.length >= 2)!;
  const because = (page: Page) => page.locator('#detail-parts tr').first().locator('td').last();

  async function detail(page: Page) {
    await page
      .locator('#feed-list > li')
      .filter({ hasText: project.title })
      .first()
      .locator('.radar-row__meta')
      .click();
    await expect(page.locator('#detail').getByRole('heading', { level: 2 })).toHaveText(
      project.title,
    );
  }

  test('with nothing ticked as in-house, Skill fit says which setting is empty', async ({
    page,
  }) => {
    await open(page);
    await detail(page);
    await expect(because(page)).toHaveText(
      `0 of ${String(project.jobs.length)} skills delivered in-house: nothing is ticked under Delivered in-house in Settings`,
    );
    // The other three parts (budget, freshness, competition) do not blame a setting.
    for (const row of [1, 2, 3]) {
      await expect(
        page.locator('#detail-parts tr').nth(row).locator('td').last(),
      ).not.toContainText('Settings');
    }
  });

  test('once a skill is ticked that the project does not need, it stops blaming the setting', async ({
    page,
  }) => {
    const other = ALL.flatMap((p) => p.jobs).find(
      (job) => !project.jobs.some((mine) => mine.id === job.id),
    )!;
    await open(page, { settings: { inHouse: [{ id: other.id, name: other.name }] } });
    await detail(page);
    await expect(because(page)).toHaveText(
      `0 of ${String(project.jobs.length)} skills delivered in-house`,
    );
  });

  test('with a matching skill ticked it reads as before', async ({ page }) => {
    const mine = project.jobs[0]!;
    await open(page, { settings: { inHouse: [{ id: mine.id, name: mine.name }] } });
    await detail(page);
    await expect(because(page)).toHaveText(
      `1 of ${String(project.jobs.length)} skills delivered in-house`,
    );
  });
});
