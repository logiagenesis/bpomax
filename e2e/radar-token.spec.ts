import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll } from './helpers.js';
import { NEWEST, serveFreelancer } from './radar-helpers.js';

/**
 * The Freelancer token in Radar's settings (LI-PROMPT-BPOMAX-AUTOBID-20260928, step 1 and
 * constraint 2): masked, kept only in this browser, checked against GET /users/0.1/self/,
 * left out of Export, removable, and warned about 5 days before its 30 run out.
 */
const NOW = NEWEST + 5 * 60_000;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'e2e-token-abcdefghijklmnopqrstuvwxyz-7Q9Z';

async function open(page: Page, options: Parameters<typeof serveFreelancer>[1] = {}) {
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page, options);
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  await page.getByRole('tab', { name: 'Settings' }).click();
  return calls;
}

const input = (page: Page) => page.getByLabel('Paste a token');

test('a pasted token is checked with Freelancer.com, masked and kept in this browser only', async ({
  page,
}) => {
  const calls = await open(page);
  await expect(page.locator('#token-state')).toHaveText('No token saved.');
  await expect(input(page)).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Remove token' })).toBeHidden();

  await input(page).fill(`  ${TOKEN}\n`);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Freelancer.com accepted the token: you are example-user (user 1234567).',
  );
  expect(calls.self).toEqual([TOKEN]);
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('#token-state')).toHaveText(
    'Token ••••••••7Q9Z, pasted 27/09/2026, lasts until 27/10/2026.',
  );
  await expect(page.locator('#token-account')).toHaveText(
    /^Freelancer\.com says this is example-user \(user 1234567\), plus membership, 100 bids a month\. Checked 27\/09\/2026 \d\d:\d\d SAST\.$/,
  );
  await expect(page.locator('#token-warning')).toBeHidden();
  // Nowhere on the page in full.
  expect(await page.content()).not.toContain(TOKEN);

  // Kept after a reload, and checked again on request.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#token-state')).toContainText('••••••••7Q9Z');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('#status')).toHaveText(/^Freelancer\.com accepted the token/);
  expect(calls.self).toEqual([TOKEN, TOKEN]);

  // Export leaves it out.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const exported = readFileSync(String(await (await downloading).path()), 'utf8');
  expect(exported).not.toContain(TOKEN);
  expect(exported).not.toContain('7Q9Z');

  // Removed after a confirm.
  await page.getByRole('button', { name: 'Remove token' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#status')).toHaveText('The token is removed from this browser.');
  await expect(page.locator('#token-state')).toHaveText('No token saved.');
  expect(await page.evaluate(() => localStorage.getItem('radar.token'))).toBeNull();
});

test('a token Freelancer.com refuses is not kept, and the page says what to do', async ({
  page,
}) => {
  await open(page, { self: 401 });
  await input(page).fill(TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  const line =
    'Token rejected (HTTP 401: You must be logged in to perform this request). Generate a new one at accounts.freelancer.com/settings/develop.';
  await expect(page.locator('#token-error')).toHaveText(line);
  await expect(page.locator('#status')).toHaveText(line);
  await expect(page.locator('#token-state')).toHaveText('No token saved.');
  expect(await page.evaluate(() => localStorage.getItem('radar.token'))).toBeNull();
});

test('what is not a token is caught before anything is sent', async ({ page }) => {
  const calls = await open(page);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.locator('#token-error')).toHaveText('Paste the token first.');
  await input(page).fill('abc 123');
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.locator('#token-error')).toHaveText(
    'A token has no spaces in it. Paste it again, on its own.',
  );
  expect(calls.self).toEqual([]);
});

test('5 days before the 30 run out the page warns on every tab, then says it has run out', async ({
  page,
}) => {
  await page.addInitScript(
    ([token, savedAt]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'radar.token',
        JSON.stringify({ token, savedAt, account: null, checkedAt: null, problem: null }),
      );
    },
    [TOKEN, NOW - 26 * DAY] as const,
  );
  await page.clock.install({ time: NOW });
  await serveFreelancer(page);
  await page.goto('/radar.html');
  const warning = page.locator('#token-warning');
  await expect(warning).toHaveText(
    'Your Freelancer token runs out on 01/10/2026, in 4 days. Generate a new one at accounts.freelancer.com/settings/develop and paste it in Settings.',
  );
  await page.clock.setSystemTime(NOW + 5 * DAY);
  await page.reload();
  await expect(warning).toHaveText(
    'Your Freelancer token ran out on 01/10/2026. Generate a new one at accounts.freelancer.com/settings/develop and paste it in Settings.',
  );
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#token-state')).toHaveText(
    'Token ••••••••7Q9Z, pasted 01/09/2026, ran out on 01/10/2026.',
  );
});

test('the token field works at 380 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await input(page).fill(TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.locator('#token-account')).toBeVisible();
  await expectNoSidewaysScroll(page);
});
