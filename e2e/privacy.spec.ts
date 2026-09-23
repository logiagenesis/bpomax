import { expect, test, type Page } from '@playwright/test';
import { expectEveryLinkGoesSomewhere, expectNoSidewaysScroll } from './helpers.js';

/**
 * ARB-015: the privacy notice page. The committed notice is pending (docs/02 T-06), so
 * the first case runs against the real file; the others answer the page's request for
 * `privacy-notice.json` with what an owner might publish. The wording in them is
 * placeholder text for the test, not a notice.
 */
async function serveNotice(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route('**/privacy-notice.json', (route) =>
    route.fulfill({ status, json: body as Record<string, unknown> }),
  );
}

test('the committed notice is pending: the page says so, names T-06 and shows no wording', async ({
  page,
}) => {
  await page.goto('/privacy.html');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await expect(page.locator('#privacy-pending')).toBeVisible();
  await expect(page.locator('#privacy-pending')).toContainText('docs/02 T-06');
  await expect(page.locator('#privacy-notice')).toBeHidden();
  await expect(page.locator('#privacy-approval')).toBeHidden();
  await expectEveryLinkGoesSomewhere(page);
});

test('approved wording is shown section by section, with who approved it and when', async ({
  page,
}) => {
  await serveNotice(page, {
    status: 'approved',
    approvedBy: 'Approver name',
    approvedOn: '2026-10-01',
    version: 'v1',
    sections: [
      { heading: 'Heading one', paragraphs: ['Paragraph one.', 'Paragraph two.'] },
      { heading: 'Heading two', paragraphs: ['Paragraph three.'] },
    ],
  });
  await page.goto('/privacy.html');
  await expect(page.locator('#privacy-approval')).toHaveText(
    'Version v1, approved by Approver name on 01/10/2026.',
  );
  await expect(page.locator('#privacy-notice h2')).toHaveText(['Heading one', 'Heading two']);
  await expect(page.locator('#privacy-notice p')).toHaveText([
    'Paragraph one.',
    'Paragraph two.',
    'Paragraph three.',
  ]);
  await expect(page.locator('#privacy-pending')).toBeHidden();
});

test('a pending file that carries wording is refused, and none of it is shown', async ({
  page,
}) => {
  await serveNotice(page, {
    status: 'pending',
    sections: [{ heading: 'Draft heading', paragraphs: ['Draft text.'] }],
  });
  await page.goto('/privacy.html');
  await expect(page.locator('#status')).toHaveText(
    'The published privacy notice is incomplete, so none is shown. The site owner needs to correct it.',
  );
  await expect(page.getByText('Draft text.')).toHaveCount(0);
  await expect(page.locator('#privacy-pending')).toBeHidden();
});

test('a notice that cannot be loaded is reported with what to do', async ({ page }) => {
  await serveNotice(page, { error: 'missing' }, 404);
  await page.goto('/privacy.html');
  await expect(page.locator('#status')).toHaveText(
    'The privacy notice could not be loaded (the server answered 404). Reload the page to try again.',
  );
});

test('the brand link and the sign-in link go where they say', async ({ page }) => {
  await page.goto('/privacy.html');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\.html$/);
  await page.getByRole('link', { name: 'Privacy notice' }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
  await page.getByRole('link', { name: 'Arbitron' }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
  await expect(page.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute(
    'href',
    './privacy.html',
  );
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/privacy.html');
  await expect(page.locator('#privacy-pending')).toBeVisible();
  await expectNoSidewaysScroll(page);
});
