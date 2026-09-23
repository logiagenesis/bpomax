import { expect, test } from '@playwright/test';

/**
 * Demo mode (D-043): the build deployed while credentials are missing. Every page must
 * open from its own link, say it is a demo, and show sample data rather than an error.
 * Actions work against the tab's sample data and show up in the audit log. Nothing
 * reaches a server: the only requests the pages make are for the site's own files.
 */
const SIGNED_IN: [string, RegExp | string, boolean][] = [
  ['/dashboard.html', 'Figures are up to date.', true],
  ['/feed.html', /^Loaded \d+ jobs\.$/, true],
  ['/approvals.html', /^Loaded \d+ bids?( and \d+ repl(y|ies))?\.$/, true],
  ['/conversations.html', /^Loaded \d+ conversations?\.$/, true],
  ['/suppliers.html', /^Loaded \d+ suppliers?\.$/, true],
  ['/sourcing.html', /^Loaded \d+ sourcing requests?\.$/, true],
  ['/settings.html', 'Settings loaded.', true],
  // The audit log predates the shared page shell and has no "who" line.
  ['/audit-log.html', /^Loaded \d+ events?\.$/, false],
];

for (const [path, status, shell] of SIGNED_IN) {
  test(`${path} opens from its own link with sample data and the demo banner`, async ({ page }) => {
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:')) outside.push(request.url());
    });
    await page.goto(path);
    await expect(page.locator('#demo-banner')).toContainText('Demo mode: sample data only.');
    await expect(page.locator('#status')).toHaveText(status);
    if (shell) {
      await expect(page.locator('#who')).toHaveText('Demo Owner · owner · Logi-Ink (demo)');
    }
    expect(outside).toEqual([]);
  });
}

for (const path of ['/index.html', '/login.html', '/privacy.html', '/style-guide.html']) {
  test(`${path} opens with the demo banner`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
  });
}

test('any email and password sign in, and the dashboard opens', async ({ page }) => {
  await page.goto('/login.html');
  await page.getByLabel('Email').fill('visitor@example.com');
  await page.getByLabel('Password').fill('anything');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await expect(page.locator('#status')).toHaveText('Figures are up to date.');
});

test('an approval is kept for the tab and appears in the audit log; reset brings the sample back', async ({
  page,
}) => {
  await page.goto('/approvals.html');
  await expect(page.locator('#status')).toHaveText('Loaded 2 bids and 1 reply.');
  await page.getByRole('button', { name: 'Approve Shopify store rebuild (sample)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#status')).toContainText('Approved');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('proposal.approved');
  await page.goto('/approvals.html');
  await expect(page.locator('#status')).toHaveText('Loaded 1 bid and 1 reply.');
  // The sample reply (ARB-122) is approved the same way and logged the same way.
  await page.getByRole('button', { name: 'Approve reply to acme-shop (sample)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#status')).toContainText('Approved the reply to “acme-shop (sample)”');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('message.approved');
  await page.goto('/approvals.html');
  await expect(page.locator('#status')).toHaveText('Loaded 1 bid.');
  await page.getByRole('button', { name: 'Reset the sample data' }).click();
  await expect(page.locator('#status')).toHaveText('Loaded 2 bids and 1 reply.');
});

test('a reply queued from a sample conversation waits in Approvals and is in the audit log', async ({
  page,
}) => {
  await page.goto('/conversations.html');
  await expect(page.locator('#status')).toHaveText('Loaded 2 conversations.');
  await page.getByRole('button', { name: 'Open the conversation with acme-shop (sample)' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Opened the conversation with acme-shop (sample).',
  );
  await expect(page.locator('#messages li')).toHaveCount(3);
  await expect(page.locator('#discovery-completeness')).toHaveText('30 %');
  await page.getByLabel('Reply').fill('Monday at 09:00 works for us. (sample)');
  await page.getByRole('button', { name: 'Queue reply' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Your reply to acme-shop (sample) is waiting for approval in Approvals.',
  );
  await expect(page.locator('#messages li')).toHaveCount(4);
  await page.goto('/approvals.html');
  await expect(page.locator('#status')).toHaveText('Loaded 2 bids and 2 replies.');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('message.drafted');
});

test('a supplier CSV pasted in the demo is checked by the real rule and imported into the tab', async ({
  page,
}) => {
  await page.goto('/suppliers.html');
  await expect(page.locator('#status')).toHaveText('Loaded 2 suppliers.');
  const heading =
    'name,country_code,time_zone,channel,languages,quality_score,on_time_rate,pays_after_delivery,external_profile_url,notes,active,category_slug,currency,fixed_price,hourly_rate,turnaround_days';
  await page
    .getByLabel('Or paste the CSV')
    .fill(`${heading}\nNew One (sample),ZA,,direct,,,,yes,,,yes,plumbing,ZAR,100,,`);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expect(page.locator('#import-errors li')).toHaveText([
    'Line 2, category_slug: is not a service category.',
  ]);
  await page
    .getByLabel('Or paste the CSV')
    .fill(`${heading}\nNew One (sample),ZA,,direct,,,,yes,,,yes,shopify,ZAR,100,,`);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Imported 1 supplier and 1 rate card (1 new, 0 updated).',
  );
  await expect(page.locator('#rows tr')).toHaveCount(3);
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('supplier.imported');
});

test('the sample sourcing request is ranked by the real rule, and a shortlist is kept for the tab', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  await expect(page.locator('#status')).toHaveText('Loaded 1 sourcing request.');
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  await expect(page.locator('#request-status')).toContainText('1 supplier ranked, 1 not ranked');
  await expect(page.locator('#candidate-rows tr').first()).toContainText('Thandi Web (sample)');
  await expect(page.locator('#candidate-rows tr').first()).toContainText('R1 500,00 fixed');
  await expect(page.locator('#excluded li')).toHaveText(['Studio Nord (sample): inactive.']);
  await page.getByRole('button', { name: 'Shortlist Thandi Web (sample)' }).click();
  await expect(page.locator('#request-status')).toHaveText('Shortlisted Thandi Web (sample).');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('sourcing.shortlisted');
});

test('the settings rules are the real ones: live mode stays off until every rule is set', async ({
  page,
}) => {
  await page.goto('/settings.html');
  await expect(page.locator('#status')).toHaveText('Settings loaded.');
  await expect(page.getByRole('switch', { name: 'Organisation live mode' })).toBeDisabled();
  await expect(page.locator('#live-blockers-list li')).toHaveCount(5);
});

test('connecting Freelancer.com in the demo returns at once with a sample account', async ({
  page,
}) => {
  await page.goto('/settings.html');
  await expect(page.locator('#connect-hint')).toContainText('Nothing reaches Freelancer.com.');
  await page.getByRole('button', { name: 'Connect Freelancer.com' }).click();
  await expect(page).toHaveURL(/\/freelancer-callback\.html$/);
  await expect(page.locator('#status')).toHaveText(
    'Connected the Freelancer.com account sample-account (demo).',
  );
});
