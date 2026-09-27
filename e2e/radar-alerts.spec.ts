import { expect, test, type Page } from '@playwright/test';
import { NEWEST, PROJECTS, serveFreelancer } from './radar-helpers.js';

/**
 * Alerts (LI-PROMPT-BPOMAX-RADAR-20260927, 4.7). The browser's Notification is replaced
 * before the page loads by a recorder, with the permission the test chooses, so what the
 * page would show can be read back.
 */
const NOW = NEWEST + 5 * 60_000;
const ALL = PROJECTS.result.projects;

async function open(page: Page, permission: 'default' | 'granted' | 'denied', answer = permission) {
  await page.addInitScript(
    ([start, reply]) => {
      const shown: { title: string; body: string; tag: string }[] = [];
      (window as unknown as { __shown: typeof shown }).__shown = shown;
      class Recorder extends EventTarget {
        // A browser remembers the answer across reloads; so does this.
        static permission = sessionStorage.getItem('permission') ?? start;
        static async requestPermission() {
          Recorder.permission = reply;
          sessionStorage.setItem('permission', reply);
          return reply;
        }
        constructor(title: string, options: { body: string; tag: string }) {
          super();
          shown.push({ title, body: options.body, tag: options.tag });
        }
        close() {}
      }
      Object.defineProperty(window, 'Notification', { value: Recorder, configurable: true });
    },
    [permission, answer] as const,
  );
  await page.clock.install({ time: NOW });
  const calls = await serveFreelancer(page);
  await page.goto('/radar.html');
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  return calls;
}

const shown = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __shown: { title: string; body: string; tag: string }[] }).__shown,
  );

/** The feed's rows scoring `threshold` or more that were posted under 15 minutes before NOW. */
async function expectedAlerts(page: Page, threshold: number) {
  const fresh = new Set(
    ALL.filter((p) => NOW - p.time_submitted * 1000 < 15 * 60_000).map((p) => p.title),
  );
  const rows = await page.locator('#feed-list > li').evaluateAll((items) =>
    items.map((li) => ({
      title: li.querySelector('h3')?.textContent ?? '',
      score: Number.parseInt(li.querySelector('.radar-score')?.textContent ?? '0', 10),
    })),
  );
  return rows.filter((r) => r.score >= threshold && fresh.has(r.title));
}

test('turning alerts on asks the browser, then notifies each fresh top project once', async ({
  page,
}) => {
  const calls = await open(page, 'default', 'granted');
  expect(await shown(page)).toEqual([]);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#alerts-state')).toHaveText('Alerts are off.');
  await expect(page.getByLabel('Lowest rank score to notify')).toHaveValue('70');
  await page.getByLabel('Lowest rank score to notify').fill('45');
  await page.getByLabel('Notify me when a new top project appears').check();
  await expect(page.locator('#status')).toHaveText('Alerts are on.');
  await expect(page.locator('#alerts-state')).toHaveText(
    'Alerts are on for projects scoring 45 or more.',
  );

  const want = await expectedAlerts(page, 45);
  expect(want.length).toBeGreaterThan(0);
  const first = await shown(page);
  expect(first.map((n) => n.title)).toEqual(
    want.map((r) => `Radar ${String(r.score)}: ${r.title}`),
  );
  expect(new Set(first.map((n) => n.tag)).size).toBe(first.length);

  // The next read finds the same projects: nothing new is shown.
  await page.clock.runFor(2 * 60_000);
  await expect.poll(() => calls.projects.length).toBe(2);
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  expect(await shown(page)).toHaveLength(first.length);

  // Nor after a reload: the notified projects are remembered.
  await page.reload();
  await expect(page.locator('#status')).toHaveText(/^Read \d+ projects/);
  expect(await shown(page)).toEqual([]);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Notify me when a new top project appears')).toBeChecked();
});

test('with alerts off, or at a threshold nothing reaches, nothing is shown', async ({ page }) => {
  await open(page, 'granted');
  expect(await shown(page)).toEqual([]);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Lowest rank score to notify').fill('100');
  await page.getByLabel('Notify me when a new top project appears').check();
  expect(await expectedAlerts(page, 100)).toEqual([]);
  expect(await shown(page)).toEqual([]);
  await page.getByLabel('Notify me when a new top project appears').uncheck();
  await expect(page.locator('#status')).toHaveText('Alerts are off.');
});

test('when the browser refuses, alerts stay off and the page says why', async ({ page }) => {
  await open(page, 'default', 'denied');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Notify me when a new top project appears').click();
  await expect(page.getByLabel('Notify me when a new top project appears')).not.toBeChecked();
  await expect(page.locator('#alerts-state')).toHaveText(
    'Notifications are blocked for this site in your browser’s settings, so alerts stay off.',
  );
  expect(await shown(page)).toEqual([]);
});
