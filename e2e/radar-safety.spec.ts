import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Nothing unfinished reaches a client (LI-PROMPT-BPOMAX-FIX-20260929, batch 1). A proposal
 * with a `{placeholder}` still in it can be neither copied (Bid on Freelancer) nor placed
 * (Place now); Place now stops at the monthly limit; and the feed says when the rank has no
 * skills to work from. Every call to Freelancer.com is answered by the stand-in in
 * radar-helpers.ts, which records what reached it.
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const NOW = NEWEST + 5 * 60_000; // 27/09/2026 08:53 SAST
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

/** Its `{skills}` is filled only from the project's skills that are ticked as in-house. */
const WITH_SKILLS = {
  id: 'tpl-skills',
  name: 'With skills',
  body: 'Hello. About {title}: I bring {skills}. My price is {price}, in {timeline_days} days.',
  isDefault: true,
};
const PLAIN = {
  id: 'tpl-plain',
  name: 'Plain',
  body: 'Hello. About {title}: I can do this for {price} in {timeline_days} days.',
  isDefault: true,
};

function logged(n: number, placedAt: string) {
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
    templateId: null,
    templateName: null,
    proposal: 'Hello.',
    score: 75,
    scoreParts: { skill: 35, budget: 10, fresh: 20, competition: 10 },
    bidCount: 3,
    ageMinutes: 12,
    placedAt,
    status: 'sent',
    replied: false,
    award: null,
  };
}

interface Seed {
  templates?: unknown[];
  settings?: Record<string, unknown>;
  log?: unknown[];
  token?: boolean;
}

/** Puts the owner's state in the browser before the page loads, once per tab. */
async function open(page: Page, seed: Seed = {}) {
  const token = seed.token
    ? {
        token: TOKEN,
        savedAt: NOW - 60_000,
        account: ACCOUNT,
        checkedAt: NOW - 60_000,
        problem: null,
      }
    : null;
  await page.addInitScript(
    ([templates, settings, log, stored]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      if (templates) localStorage.setItem('radar.templates', JSON.stringify(templates));
      if (settings) localStorage.setItem('radar.settings', JSON.stringify(settings));
      if (log) localStorage.setItem('radar.log', JSON.stringify(log));
      if (stored) localStorage.setItem('radar.token', JSON.stringify(stored));
    },
    [seed.templates ?? null, seed.settings ?? null, seed.log ?? null, token] as const,
  );
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page);
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
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const SENTINEL = 'nothing was copied';

/** Counts the tabs the page opens on Freelancer.com. */
function countPopups(page: Page) {
  const seen = { count: 0 };
  page.on('popup', () => {
    seen.count += 1;
  });
  return seen;
}

test.describe('R-01: an unfilled placeholder never reaches a client', () => {
  test('{skills} with no in-house overlap: neither copied nor placed, and nothing is sent', async ({
    page,
  }) => {
    const calls = await open(page, { templates: [WITH_SKILLS], token: true });
    const popups = countPopups(page);
    const dialog = await detailOf(page, RECRUITER.title);
    // Nothing is ticked as in-house, so the template's {skills} is left as written.
    await expect(dialog.getByLabel('Proposal')).toHaveValue(/I bring \{skills\}\./);
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeVisible();
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);

    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await expect(dialog.locator('#p-error')).toHaveText('Fill or remove {skills} before bidding.');
    await expect(dialog.locator('#bid-panel')).toBeHidden();
    expect(await clipboard(page)).toBe(SENTINEL);

    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText('Fill or remove {skills} before bidding.');
    await expect(confirmDialog(page)).toHaveCount(0);

    expect(popups.count).toBe(0);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
  });

  test('a placeholder typed into the text is refused by name, until it is taken out', async ({
    page,
  }) => {
    const calls = await open(page, { templates: [PLAIN], token: true });
    const popups = countPopups(page);
    const dialog = await detailOf(page, RECRUITER.title);
    const text = dialog.getByLabel('Proposal');
    await page.evaluate((value) => navigator.clipboard.writeText(value), SENTINEL);

    await text.fill('Hi {made_up}, about {Title} and {made_up} again. { price }');
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(
      'Fill or remove {made_up}, {Title} and {price} before bidding.',
    );
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(
      'Fill or remove {made_up}, {Title} and {price} before bidding.',
    );
    expect(popups.count).toBe(0);
    expect(await clipboard(page)).toBe(SENTINEL);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);

    // Take them out: the paste path copies and opens the project ...
    const clean = 'Hi, I can do this in 7 days for USD 450.';
    await text.fill(clean);
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await popup;
    await expect(dialog.locator('#p-error')).toBeHidden();
    expect(await clipboard(page)).toBe(clean);

    // ... and Place now reaches its confirm, where Cancel still sends nothing.
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('with the skill ticked as in-house, {skills} is filled and Place now sends it', async ({
    page,
  }) => {
    const skill = RECRUITER.jobs[0]!;
    const calls = await open(page, {
      templates: [WITH_SKILLS],
      settings: { inHouse: [{ id: skill.id, name: skill.name }] },
      token: true,
    });
    const dialog = await detailOf(page, RECRUITER.title);
    const proposal = await dialog.getByLabel('Proposal').inputValue();
    expect(proposal).toContain(`I bring ${skill.name}.`);
    expect(proposal).not.toMatch(/[{}]/);

    await dialog.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
    await expect(page.locator('#status')).toContainText('Placed your bid on');
    expect(calls.bidsSent).toHaveLength(1);
    expect(calls.bidsSent[0]!.body['description']).toBe(proposal.trim());
  });
});

test.describe('R-06: Place now stops at the monthly limit', () => {
  // Two bids in September 2026 SAST and one in August, which is not counted.
  const LOG = [
    logged(1, '2026-09-20T08:00:00.000Z'),
    logged(2, '2026-09-15T08:00:00.000Z'),
    logged(3, '2026-08-10T08:00:00.000Z'),
  ];

  test('at the limit it refuses, with the count, and sends nothing; the paste path is unchanged', async ({
    page,
  }) => {
    const calls = await open(page, {
      templates: [PLAIN],
      settings: { monthlyLimit: 2 },
      log: LOG,
      token: true,
    });
    await expect(page.locator('#bid-counter')).toHaveText('Bids this month: 2 / 2');
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(
      'The monthly limit in Settings is reached (2 of 2 bids logged this month), so Place now is off.',
    );
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);

    // Bid on Freelancer is the owner's own submission on Freelancer.com; the limit is not
    // applied to it.
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await popup;
  });

  for (const limit of [3, null]) {
    test(`with ${limit === null ? 'no limit set' : 'room under a limit of 3'} it goes on to its confirm`, async ({
      page,
    }) => {
      const calls = await open(page, {
        templates: [PLAIN],
        settings: { monthlyLimit: limit },
        log: LOG,
        token: true,
      });
      const dialog = await detailOf(page, RECRUITER.title);
      await dialog.getByRole('button', { name: 'Place now' }).click();
      await expect(confirmDialog(page)).toBeVisible();
      await expect(dialog.locator('#p-error')).toBeHidden();
      await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
      expect(calls.bidsSent).toHaveLength(0);
    });
  }
});

test.describe('R-03: the feed says when the rank has no skills to work from', () => {
  const NOTE =
    'Ranking is incomplete until you pick skills and tick what Logi-Ink delivers in-house.';
  const skill = RECRUITER.jobs[0]!.name;

  test('shows on fresh storage, goes once both are set, and returns when one is taken away', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await open(page);
    await expect(page.locator('#rank-note')).toHaveText(NOTE);
    await expectNoSidewaysScroll(page);

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Find an in-house skill').fill(skill);
    await page
      .locator('#inhouse-matches')
      .getByRole('checkbox', { name: skill, exact: true })
      .check();
    await page.getByRole('tab', { name: 'Feed' }).click();
    await expect(page.locator('#rank-note')).toHaveText(NOTE); // in-house alone is not enough

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Find a skill', { exact: true }).fill(skill);
    await page
      .locator('#watch-matches')
      .getByRole('checkbox', { name: skill, exact: true })
      .check();
    await page.getByRole('tab', { name: 'Feed' }).click();
    await expect(page.locator('#rank-note')).toBeHidden();

    await page.reload();
    await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
    await expect(page.locator('#rank-note')).toBeHidden();

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page
      .locator('#inhouse-chosen')
      .getByRole('button', { name: `Remove ${skill}` })
      .click();
    await page.getByRole('tab', { name: 'Feed' }).click();
    await expect(page.locator('#rank-note')).toHaveText(NOTE);
  });
});
