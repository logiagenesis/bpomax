import { expect, test, type Page } from '@playwright/test';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Place now (LI-PROMPT-BPOMAX-AUTOBID-20260928, step 3): with a token Freelancer.com
 * accepted, the project's bid panel can send the bid itself. It first asks Freelancer.com
 * for an earlier bid of the owner's on the project and sends nothing if there is one
 * (constraint 4), then POSTs the bid as F2 describes, and logs it with Freelancer's bid
 * id and the answer's status (constraint 5). Every call is answered here.
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

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
    templates?: unknown[];
    settings?: Record<string, unknown>;
    log?: unknown[];
    account?: Partial<typeof ACCOUNT>;
    /** A refusal recorded on the saved token, as a failed check leaves it. */
    tokenProblem?: string;
    /** The token check is never answered. */
    selfHang?: boolean;
  } = {},
) {
  const token =
    options.token === false
      ? null
      : {
          token: TOKEN,
          savedAt: NOW - 60_000,
          account: { ...ACCOUNT, ...options.account },
          checkedAt: NOW - 60_000,
          problem: options.tokenProblem ?? null,
        };
  await page.addInitScript(
    ([templates, stored, settings, log]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('radar.templates', JSON.stringify(templates));
      if (stored) localStorage.setItem('radar.token', JSON.stringify(stored));
      if (settings) localStorage.setItem('radar.settings', JSON.stringify(settings));
      if (log) localStorage.setItem('radar.log', JSON.stringify(log));
    },
    [
      options.templates ?? [TEMPLATE],
      token,
      options.settings ?? null,
      options.log ?? null,
    ] as const,
  );
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, {
    bids: options.bids,
    selfHang: options.selfHang,
  });
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
    outcome: 'placed',
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
  // The entry is this browser's only record of a bid that is real: it says so, and it counts.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.log') ?? '[]'));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ freelancerBidId: '777', outcome: 'already' });
  // With the token's account limit of 100 a month (Freelancer's own) as the limit.
  await expect(page.locator('#bid-counter')).toHaveText(
    'Bids logged in this browser this month: 1 / 100',
  );
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

// ------------------------------------------------------------------ B-01
// Any text in curly braces is blocked (LI-PROMPT-BPOMAX-BIDSAFETY-20260929, B-01): neither
// bid path copies, confirms or sends it, and the message names what to fix.

const WITH_SKILLS = {
  id: 'tpl-skills',
  name: 'With skills',
  body: 'Hello. About {title}: I bring {skills}. My price is {price}, in {timeline_days} days.',
  isDefault: true,
};
const SENTINEL = 'nothing was copied';
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const BRACES_MESSAGE =
  'Fill or remove {skills} before bidding. Any text in curly braces is blocked.';

/** Counts the tabs the page opens. */
function countPopups(page: Page) {
  const seen = { count: 0 };
  page.on('popup', () => {
    seen.count += 1;
  });
  return seen;
}

test.describe('B-01: text in curly braces never reaches a client', () => {
  test('{skills} on a project with no in-house overlap: not copied, not placed, and named', async ({
    page,
  }) => {
    const calls = await open(page, { templates: [WITH_SKILLS] });
    const popups = countPopups(page);
    const dialog = await detailOf(page, RECRUITER.title);
    // Nothing is ticked as in-house, so the template's {skills} is left as written.
    await expect(dialog.getByLabel('Proposal')).toHaveValue(/I bring \{skills\}\./);
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);

    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await expect(dialog.locator('#p-error')).toBeVisible();
    await expect(dialog.locator('#p-error')).toHaveText(BRACES_MESSAGE);
    await expect(dialog.locator('#bid-panel')).toBeHidden();
    expect(await clipboard(page)).toBe(SENTINEL);

    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toBeVisible();
    await expect(dialog.locator('#p-error')).toHaveText(BRACES_MESSAGE);
    await expect(confirmDialog(page)).toHaveCount(0);

    expect(popups.count).toBe(0);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
  });

  test('skills ticked that the project does not need do not fill {skills} either', async ({
    page,
  }) => {
    const other = ALL.flatMap((p) => p.jobs).find(
      (job) => !RECRUITER.jobs.some((mine) => mine.id === job.id),
    )!;
    const calls = await open(page, {
      templates: [WITH_SKILLS],
      settings: { inHouse: [{ id: other.id, name: other.name }] },
    });
    const dialog = await detailOf(page, RECRUITER.title);
    await expect(dialog.getByLabel('Proposal')).toHaveValue(/I bring \{skills\}\./);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(BRACES_MESSAGE);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('braces typed into the box are read as it is at the click: every one is listed, then it goes', async ({
    page,
  }) => {
    const calls = await open(page);
    const popups = countPopups(page);
    const dialog = await detailOf(page, RECRUITER.title);
    const text = dialog.getByLabel('Proposal');
    await page.evaluate((value) => navigator.clipboard.writeText(value), SENTINEL);

    await text.fill('Hi { name }, about {Client_Name}. It is {made-up} and {skills}.');
    const message =
      'Fill or remove { name }, {Client_Name}, {made-up}, {skills} before bidding. Any text in curly braces is blocked.';
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await expect(dialog.locator('#p-error')).toBeVisible();
    await expect(dialog.locator('#p-error')).toHaveText(message);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(message);
    expect(popups.count).toBe(0);
    expect(await clipboard(page)).toBe(SENTINEL);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);

    // Take the braces out: the paste path copies what is in the box, and Place now reaches
    // its confirm.
    const clean = 'Hi, I can do this in 7 days for USD 450.';
    await text.fill(clean);
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await popup;
    await expect(dialog.locator('#p-error')).toBeHidden();
    expect(await clipboard(page)).toBe(clean);
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

// ------------------------------------------------------------------ B-03
// Place now sends a fixed-price request, so it is not offered for an hourly project.

const PINS = ALL.find((p) => p.title === 'Vibrant Product Pinterest Pins')!; // USD 15–25/h
const HOURLY_LINE = 'Place now is off for hourly projects. Bid on Freelancer instead.';

test.describe('B-03: Place now is for fixed-price projects only', () => {
  test('an hourly project shows no Place now, the line in its place, and sends no request', async ({
    page,
  }) => {
    const calls = await open(page);
    const dialog = await detailOf(page, PINS.title);
    await expect(dialog.getByRole('button', { name: 'Bid on Freelancer' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeHidden();
    await expect(dialog.locator('#p-place-hint')).toBeHidden();
    await expect(dialog.locator('#p-place-off')).toBeVisible();
    await expect(dialog.locator('#p-place-off')).toHaveText(HOURLY_LINE);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);

    // A fixed-price project still has Place now, and not the line.
    await dialog.getByRole('button', { name: 'Close' }).click();
    const fixed = await detailOf(page, RECRUITER.title);
    await expect(fixed.getByRole('button', { name: 'Place now' })).toBeVisible();
    await expect(fixed.locator('#p-place-off')).toBeHidden();
  });

  test('without a token there is no line either: Place now is not on offer at all', async ({
    page,
  }) => {
    await open(page, { token: false });
    const dialog = await detailOf(page, PINS.title);
    await expect(dialog.locator('#p-place-off')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeHidden();
  });

  test('the handler refuses an hourly project too, if the button is forced into view', async ({
    page,
  }) => {
    const calls = await open(page);
    const dialog = await detailOf(page, PINS.title);
    await page.evaluate(() => {
      (document.getElementById('p-place') as HTMLButtonElement).hidden = false;
    });
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toBeVisible();
    await expect(dialog.locator('#p-error')).toHaveText(HOURLY_LINE);
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ B-04, B-05
// Place now stops at the monthly limit: the lower of the one in Settings and Freelancer.com's
// (when its period is a month), counted from the bids logged in this browser.

/** A bid in the log, as the Bids tab keeps it. */
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
// The clock stands at 27/09/2026 08:53 SAST: two of these are in September, one in August.
const SEPTEMBER_TWO = [
  logged(1, '2026-09-20T08:00:00.000Z'),
  logged(2, '2026-09-15T08:00:00.000Z'),
];
const LOG = [...SEPTEMBER_TWO, logged(3, '2026-08-10T08:00:00.000Z')];
const COUNTER = 'Bids logged in this browser this month';

test.describe('B-04: Place now stops at the monthly limit', () => {
  test('at the limit in Settings it refuses with the count, sends nothing, and Bid on Freelancer stays', async ({
    page,
  }) => {
    const calls = await open(page, { settings: { monthlyLimit: 2 }, log: LOG });
    // Radar's own count, from bids logged in this browser (August's does not count).
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 2 / 2`);
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toBeVisible();
    await expect(dialog.locator('#p-error')).toHaveText(
      'You have logged 2 bids this month and your limit is 2. Place now is off until next month.',
    );
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);

    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Bid on Freelancer' }).click();
    await popup;
  });

  test('Freelancer’s own monthly limit stops it too, with no limit in Settings', async ({
    page,
  }) => {
    const calls = await open(page, {
      log: [...SEPTEMBER_TWO, logged(4, '2026-09-10T08:00:00.000Z')],
      account: { bidLimit: 3, bidPeriod: 'month' },
    });
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 3 / 3`);
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toHaveText(
      'You have logged 3 bids this month and your limit is 3. Place now is off until next month.',
    );
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('the lower of the two wins', async ({ page }) => {
    const calls = await open(page, {
      settings: { monthlyLimit: 5 },
      log: [...SEPTEMBER_TWO, logged(4, '2026-09-10T08:00:00.000Z')],
      account: { bidLimit: 3, bidPeriod: 'month' },
    });
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 3 / 3`);
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(dialog.locator('#p-error')).toContainText('your limit is 3.');
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('a Freelancer limit for a week is not this month’s: Place now goes on to its confirm', async ({
    page,
  }) => {
    const calls = await open(page, {
      log: [...SEPTEMBER_TWO, logged(4, '2026-09-10T08:00:00.000Z')],
      account: { bidLimit: 3, bidPeriod: 'week' },
    });
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 3`);
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(dialog.locator('#p-error')).toBeHidden();
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('with room under the limit it goes on to its confirm', async ({ page }) => {
    await open(page, { settings: { monthlyLimit: 3 }, log: LOG });
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('B-05: a bid Freelancer already had still counts', () => {
  test('logging it uses up the limit, so the next Place now is refused', async ({ page }) => {
    const calls = await open(page, {
      settings: { monthlyLimit: 2 },
      log: [logged(1, '2026-09-20T08:00:00.000Z')],
      bids: { existing: { id: 777, bidder_id: 1234567, project_id: RECRUITER.id, amount: 400 } },
    });
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 1 / 2`);

    // Freelancer.com already holds a bid of his on this project; nothing new is sent.
    const first = await detailOf(page, RECRUITER.title);
    await first.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
    await expect(page.locator('#status')).toContainText('already has your bid 777');
    expect(calls.bidsSent).toHaveLength(0);
    await expect(page.locator('#bid-counter')).toHaveText(`${COUNTER}: 2 / 2`);

    // It counted: the limit of 2 is now reached, on another project.
    const other = ALL.find((p) => p.type === 'fixed' && p.id !== RECRUITER.id)!;
    const second = await detailOf(page, other.title);
    await second.getByRole('button', { name: 'Place now' }).click();
    await expect(second.locator('#p-error')).toHaveText(
      'You have logged 2 bids this month and your limit is 2. Place now is off until next month.',
    );
    expect(calls.bidLookups).toHaveLength(1);
    expect(calls.bidsSent).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ B-06
// Freelancer.com's fees page lists a minimum account balance of USD 20 before any bid
// (captured 29/09/2026). Radar only says so: it cannot check the balance.

test.describe('B-06: the USD 20 balance line', () => {
  const LINE =
    'Freelancer.com accepts bids only while your account balance is at least USD 20. Radar cannot check your balance.';

  test('shows in the bid panel under the buttons, for a fixed-price project', async ({ page }) => {
    const calls = await open(page);
    const dialog = await detailOf(page, RECRUITER.title);
    await expect(dialog.locator('#p-balance-note')).toBeVisible();
    await expect(dialog.locator('#p-balance-note')).toHaveText(LINE);
    // Under the two buttons: after the row that holds them.
    const below = await dialog.evaluate((root) => {
      const row = root.querySelector('#p-bid')!.parentElement!;
      const note = root.querySelector('#p-balance-note')!;
      return Boolean(row.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(below).toBe(true);
    // Text only: it asks Freelancer.com for nothing.
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('shows for an hourly project, and with no token saved', async ({ page }) => {
    await open(page, { token: false });
    const hourly = await detailOf(page, PINS.title);
    await expect(hourly.locator('#p-balance-note')).toBeVisible();
    await expect(hourly.locator('#p-balance-note')).toHaveText(LINE);
  });
});

// ------------------------------------------------------------------ B-09
// A 401 from Freelancer.com is a token it does not accept: the page records that on the token,
// hides Place now and says so in its place. Any other refusal, a 403 included, is
// Freelancer.com's own message and the token is left alone.

const savedToken = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('radar.token') ?? 'null'));

test.describe('B-09: a refused token hides Place now', () => {
  test('a 401 marks the token refused, hides Place now, sends nothing more, and leads to Settings', async ({
    page,
  }) => {
    const calls = await open(page, { bids: { refuse: 401 } });
    const dialog = await detailOf(page, RECRUITER.title);
    const proposal = await dialog.getByLabel('Proposal').inputValue();
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();

    // Place now is gone and the refusal is said in its place; the owner's text is untouched.
    await expect(dialog.locator('#p-token-refused')).toBeVisible();
    await expect(dialog.locator('#p-token-refused')).toContainText(
      'Freelancer refused your token.',
    );
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeHidden();
    await expect(dialog.locator('#p-place-hint')).toBeHidden();
    await expect(dialog.getByLabel('Proposal')).toHaveValue(proposal);
    await expect(dialog.getByRole('button', { name: 'Bid on Freelancer' })).toBeVisible();
    expect((await savedToken(page)).problem).toContain('HTTP 401');
    // Nothing was logged, and the lookup and the one refused POST are all that was sent.
    expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
    expect(calls.bidLookups).toHaveLength(1);
    expect(calls.bidsSent).toHaveLength(1);

    // The button closes the project and opens Settings.
    await dialog.getByRole('button', { name: 'Check it again in Settings' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('#panel-settings')).toBeVisible();
    expect(calls.bidLookups).toHaveLength(1);
    expect(calls.bidsSent).toHaveLength(1);

    // A check Freelancer.com accepts clears it, and Place now is back.
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('#status')).toHaveText(/^Freelancer\.com accepted the token/);
    expect((await savedToken(page)).problem).toBeNull();
    await page.getByRole('tab', { name: 'Feed' }).click();
    const again = await detailOf(page, RECRUITER.title);
    await expect(again.getByRole('button', { name: 'Place now' })).toBeVisible();
    await expect(again.locator('#p-token-refused')).toBeHidden();
  });

  test('a 403 shows Freelancer’s own message, keeps Place now, and does not mark the token', async ({
    page,
  }) => {
    const calls = await open(page, { bids: { refuse: 403 } });
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();

    await expect(dialog.locator('#detail-status')).toHaveText(
      'Freelancer.com refused placing the bid (HTTP 403: Refused in the e2e).',
    );
    // No "check the token" advice: what a 403 on a bid means is not known.
    await expect(dialog.locator('#detail-status')).not.toContainText('token');
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeVisible();
    await expect(dialog.locator('#p-token-refused')).toBeHidden();
    expect((await savedToken(page)).problem).toBeNull();
    expect(calls.bidsSent).toHaveLength(1);
  });

  test('another refusal, a 400, is left as it was: the message, and the token is not marked', async ({
    page,
  }) => {
    await open(page, { bids: { refuse: 400 } });
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
    await expect(dialog.locator('#detail-status')).toHaveText(
      'Freelancer.com refused placing the bid (HTTP 400: Refused in the e2e).',
    );
    expect((await savedToken(page)).problem).toBeNull();
  });

  test('a token already marked refused says so when a project is opened, and Place now is off', async ({
    page,
  }) => {
    const calls = await open(page, { tokenProblem: 'Token rejected (HTTP 401).' });
    for (const title of [RECRUITER.title, PINS.title]) {
      const dialog = await detailOf(page, title);
      await expect(dialog.locator('#p-token-refused')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Place now' })).toBeHidden();
      await expect(dialog.getByRole('button', { name: 'Bid on Freelancer' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
    }
    expect(calls.bidLookups).toHaveLength(0);
    expect(calls.bidsSent).toHaveLength(0);
  });

  test('with no token there is no such notice', async ({ page }) => {
    await open(page, { token: false });
    const dialog = await detailOf(page, RECRUITER.title);
    await expect(dialog.locator('#p-token-refused')).toBeHidden();
  });
});

// ------------------------------------------------------------------ B-10
// Freelancer.com gets 15 seconds to answer a bid or a token check. No answer is not a refusal:
// nothing is logged, nothing is retried, and the token is left as it was.

test.describe('B-10: no answer from Freelancer.com', () => {
  test('a bid with no answer says so after 15 seconds, logs nothing and is not sent again', async ({
    page,
  }) => {
    const calls = await open(page, { bids: { hang: true } });
    const dialog = await detailOf(page, RECRUITER.title);
    await dialog.getByRole('button', { name: 'Place now' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Place the bid' }).click();
    // The lookup was answered and the bid is on its way, unanswered.
    await expect.poll(() => calls.bidsSent.length).toBe(1);
    await expect(dialog.locator('#detail-status')).not.toContainText('No answer');

    await page.clock.fastForward(15_000);
    await expect(dialog.locator('#detail-status')).toHaveText(
      'No answer from Freelancer after 15 seconds. The bid may or may not have gone through. Check the project on Freelancer before trying again.',
    );
    expect(await page.evaluate(() => localStorage.getItem('radar.log'))).toBeNull();
    expect((await savedToken(page)).problem).toBeNull();
    await expect(page.locator('#bid-counter')).toHaveText(
      'Bids logged in this browser this month: 0 / 100',
    );
    // The owner can look and try again; nothing tries again by itself.
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeEnabled();
    await page.clock.fastForward(60_000);
    expect(calls.bidLookups).toHaveLength(1);
    expect(calls.bidsSent).toHaveLength(1);
  });

  test('a token check with no answer says so, and the token is not marked refused', async ({
    page,
  }) => {
    const calls = await open(page, { selfHang: true });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => calls.self.length).toBe(1);

    await page.clock.fastForward(15_000);
    await expect(page.locator('#status')).toHaveText(
      'No answer from Freelancer after 15 seconds. The token was not checked. Try again.',
    );
    expect((await savedToken(page)).problem).toBeNull();
    // Still usable: the button that was pressed is back, and Place now is on offer.
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await page.getByRole('tab', { name: 'Feed' }).click();
    const dialog = await detailOf(page, RECRUITER.title);
    await expect(dialog.getByRole('button', { name: 'Place now' })).toBeVisible();
    await expect(dialog.locator('#p-token-refused')).toBeHidden();
  });

  test('a token pasted afresh with no answer is not kept', async ({ page }) => {
    const calls = await open(page, { token: false, selfHang: true });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Paste a token').fill('e2e-token-abcdefghijklmnopqrstuvwxyz-7Q9Z');
    await page.getByRole('button', { name: 'Save and check' }).click();
    await expect.poll(() => calls.self.length).toBe(1);
    await page.clock.fastForward(15_000);
    await expect(page.locator('#token-error')).toHaveText(
      'No answer from Freelancer after 15 seconds. The token was not checked. Try again.',
    );
    expect(await page.evaluate(() => localStorage.getItem('radar.token'))).toBeNull();
  });
});
