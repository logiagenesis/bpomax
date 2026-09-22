import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * ARB-060: "Style guide page renders every component; Playwright visual snapshot stored".
 *
 * "Every component" is read out of components.css rather than listed by hand, so a
 * component added to the stylesheet and not to the page fails here.
 */
const css = readFileSync(
  new URL('../apps/web/src/styles/components.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const COMPONENT_CLASSES = [
  ...new Set(
    [...css.matchAll(/\.([a-z][a-z0-9-]*(?:(?:--|__)[a-z0-9-]+)?)(?=[\s,:{[.>])/g)].map(
      (match) => match[1]!,
    ),
  ),
];

async function open(page: Page) {
  await page.goto('/style-guide.html');
  // Every face the page uses, loaded explicitly: `fonts.ready` alone can resolve before a
  // face is first requested, and a late swap changes the layout mid-screenshot.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 1em Inter'),
      document.fonts.load('600 1em Inter'),
      document.fonts.load('400 1em "JetBrains Mono"'),
    ]);
    await document.fonts.ready;
  });
}

test('every class in components.css is used on the style guide', async ({ page }) => {
  await open(page);
  // The dialog classes exist only while a dialog is open.
  await page.getByRole('button', { name: 'Delete example' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const missing = await page.evaluate(
    (names) => names.filter((name) => !document.querySelector(`.${CSS.escape(name)}`)),
    COMPONENT_CLASSES,
  );
  expect(COMPONENT_CLASSES.length).toBeGreaterThan(40);
  expect(missing).toEqual([]);
});

test('primary button shows a loading state, then success', async ({ page }) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Save example' });
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toBeDisabled();
  await expect(page.locator('#button-status')).toHaveText(/Saved\. This is an example/);
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute('aria-busy');
});

test('a failing action says what happened and what to do next', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Show an error' }).click();
  const status = page.locator('#button-status');
  await expect(status).toHaveClass(/alert--error/);
  await expect(status).toHaveText(/Could not save.*Try again\./);
});

test('delete asks for confirmation; cancel keeps, confirm deletes', async ({ page }) => {
  await open(page);
  const status = page.locator('#button-status');

  await page.getByRole('button', { name: 'Delete example' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete the example?' });
  await expect(dialog).toBeVisible();
  // The safe choice has focus.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(status).toHaveText('Cancelled. Nothing was deleted.');

  await page.getByRole('button', { name: 'Delete example' }).click();
  await page.keyboard.press('Escape');
  await expect(status).toHaveText('Cancelled. Nothing was deleted.');

  await page.getByRole('button', { name: 'Delete example' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(status).toHaveText(/Deleted\./);
});

test('the disabled button cannot be pressed and says why', async ({ page }) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Submit bid' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(/would need an approved bid/);
});

test('the form validates, focuses the first problem, and accepts good input', async ({ page }) => {
  await open(page);
  const submit = page.getByRole('button', { name: 'Check the form' });

  await submit.click();
  await expect(page.getByLabel('Scanner name')).toBeFocused();
  await expect(page.getByLabel('Scanner name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#scanner-name-error')).toHaveText('Enter a name for the scanner.');
  await expect(page.locator('#daily-cap-error')).toHaveText('Enter a whole number from 1 to 100.');

  await page.getByLabel('Scanner name').fill('WordPress rebuilds');
  await page.getByLabel('Daily cap').fill('101');
  await submit.click();
  await expect(page.getByLabel('Daily cap')).toBeFocused();

  await page.getByLabel('Daily cap').fill('10');
  await page.getByLabel('Category').selectOption('shopify');
  await page.getByLabel('Notes').fill('Example');
  await page.getByLabel('Active').uncheck();
  await submit.click();
  await expect(page.locator('#form-status')).toHaveText(
    'The form is valid: "WordPress rebuilds", up to 10 a day. Nothing was saved.',
  );
  await expect(page.getByLabel('Scanner name')).not.toHaveAttribute('aria-invalid');
  await expect(page.getByLabel('Locked field')).toBeDisabled();
});

test('reset clears the form and its errors', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Check the form' }).click();
  await page.getByLabel('Notes').fill('Something');
  await page.getByRole('button', { name: 'Reset form' }).click();
  await expect(page.getByLabel('Notes')).toHaveValue('');
  await expect(page.locator('#scanner-name-error')).toBeHidden();
  await expect(page.locator('#button-status')).toHaveText('The form has been reset.');
});

test('live mode needs confirmation to turn on, none to turn off', async ({ page }) => {
  await open(page);
  const toggle = page.getByRole('switch', { name: 'Live mode' });
  const badge = page.locator('#live-badge');

  await toggle.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(toggle).not.toBeChecked();
  await expect(badge).toHaveText('Sandbox');

  await toggle.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn live mode on' }).click();
  await expect(toggle).toBeChecked();
  await expect(badge).toHaveText('Live');

  await toggle.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await expect(badge).toHaveText('Sandbox');
});

test('every link goes somewhere', async ({ page }) => {
  await open(page);
  for (const name of ['Colours', 'Buttons', 'Forms', 'Data', 'Feedback']) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`#${name.toLowerCase()}$`));
    await expect(page.locator(`#${name.toLowerCase()}`)).toBeInViewport();
  }
  await page.getByRole('link', { name: 'like this' }).click();
  await expect(page).toHaveURL(/#type$/);
  await page.getByRole('link', { name: 'Arbitron' }).click();
  await expect(page).toHaveURL(/\/(index\.html)?$/);
  await page.getByRole('link', { name: 'Style guide' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Style guide' })).toBeVisible();
});

test('formats: DD/MM/YYYY in SAST, R1 234,56, decimal comma', async ({ page }) => {
  await open(page);
  const table = page.locator('[data-component="table"]');
  // 21/09 22:40 UTC is already 22/09 in Johannesburg.
  await expect(table).toContainText('22/09/2026 00:40');
  await expect(table).toContainText('R8 123,45');
  await expect(table).toContainText('-R1 250,00');
  await expect(table).toContainText('USD 1 500,00');
  await expect(page.locator('[data-percent]')).toHaveText('28,4%');
});

test('the first Tab stop is the brand link, with a visible focus ring', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  const brand = page.getByRole('link', { name: 'Arbitron' });
  await expect(brand).toBeFocused();
  const shadow = await brand.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test.describe('visual snapshot', () => {
  for (const [label, width] of [
    ['desktop', 1280],
    ['380px', 380],
  ] as const) {
    test(`style guide at ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expect(page).toHaveScreenshot(`style-guide-${label}.png`, {
        fullPage: true,
        animations: 'disabled',
        // Font rasterisation differs by a few pixels between Chromium builds; a real
        // change to a component moves far more than this.
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
