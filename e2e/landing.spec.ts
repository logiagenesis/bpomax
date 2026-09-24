import { expect, test } from '@playwright/test';
import { expectEveryLinkGoesSomewhere, expectNoSidewaysScroll } from './helpers.js';

/**
 * ARB-440: the landing page. Every link on it goes where it says; the copy itself is held
 * to docs/05 section 2 by tests/copy-audit.test.ts and reviewed sentence by sentence in
 * docs/audit/index.md; Lighthouse is e2e/lighthouse.mjs.
 */
test('says what the product does, and offers sign-up and sign-in', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByRole('heading', { level: 1, name: 'Arbitron' })).toBeVisible();
  await expect(page.locator('#how-it-works + ol > li h3')).toHaveText([
    'Find',
    'Qualify',
    'Price',
    'Contact',
    'Brief',
    'Source',
    'Deliver',
    'Learn',
  ]);
  await expectEveryLinkGoesSomewhere(page);
});

test('Create an account goes to sign-up, and Sign in to the login page', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('.landing__hero').getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/signup\.html$/);
  await page.goto('/index.html');
  await page.locator('.landing__hero').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\.html$/);
});

test('the site navigation goes to each section on the page', async ({ page }) => {
  await page.goto('/index.html');
  for (const [name, id] of [
    ['How it works', 'how-it-works'],
    ['Safeguards', 'safeguards'],
    ['Marketplaces', 'marketplaces'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
});

test('the footer links go to the privacy notice, the terms and the account pages', async ({
  page,
}) => {
  await page.goto('/index.html');
  const footer = page.locator('footer');
  for (const [name, path] of [
    ['Privacy notice', 'privacy.html'],
    ['Terms of service', 'terms.html'],
    ['Create an account', 'signup.html'],
    ['Sign in', 'login.html'],
  ] as const) {
    await expect(footer.getByRole('link', { name })).toHaveAttribute('href', `./${path}`);
  }
  await footer.getByRole('link', { name: 'Privacy notice' }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
});

test('shows no price, count, rating or deadline', async ({ page }) => {
  await page.goto('/index.html');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/R\s?\d|\$\s?\d|USD\s?\d|\d+\s?%|★|\bdays? left\b/);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/index.html');
  await expectNoSidewaysScroll(page);
});
