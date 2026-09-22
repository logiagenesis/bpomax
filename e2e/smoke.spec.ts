import { expect, test } from '@playwright/test';

// Page-by-page button and control coverage arrives with ARB-061 (05 section 1).
// This smoke test proves the build is served and the CI browser path works.
test('the web build serves the landing page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Arbitron' })).toBeVisible();
});
