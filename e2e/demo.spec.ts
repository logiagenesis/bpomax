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
  ['/pipeline.html', /^Loaded \d+ jobs? in the pipeline\.$/, true],
  ['/templates.html', /^Showing \d+ templates?\.$/, true],
  ['/analytics.html', /^Counted \d+ bids? by category\.$|^No bids sent yet\.$/, true],
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

test('Reprice in the demo judges the quote by the real rule: with the rules unset it is blocked and names them', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  const row = page.locator('#candidate-rows tr').first();
  await expect(row.locator('[data-margin]')).toHaveText('Not priced yet');
  await page
    .getByRole('button', { name: 'Reprice the bid with Thandi Web (sample)’s quote' })
    .click();
  await expect(row.locator('[data-margin]')).toHaveText('Not priced: a margin rule is not set');
  await expect(row).toContainText('fee_table (docs/02 T-02)');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('margin.repriced');
});

test('with rules set in the tab, Reprice works the margin with the real engine', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  // The rules and the fee table are this test's data (docs/02 D-02, D-03, T-02 are open).
  const answers = await page.evaluate(async () => {
    const send = (body: unknown) =>
      fetch('https://demo-api.invalid/v1/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.status);
    return [
      await send({ minMarginPct: 20, minMarginZarMinor: 50000, fxBufferPct: 3 }),
      await send({
        feeTable: [
          {
            platform: 'freelancer',
            project_type: 'fixed',
            side: 'freelancer',
            percent: 10,
            source_url: 'https://example.test/fees',
            read_on: '2026-09-22',
          },
        ],
      }),
    ];
  });
  expect(answers).toEqual([200, 200]);
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  await page
    .getByRole('button', { name: 'Reprice the bid with Thandi Web (sample)’s quote' })
    .click();
  // Hand-worked: R12 000,00 − 10% fee R1 200,00 − quote R1 500,00 = R9 300,00, 77,5%.
  const figure = page.locator('#candidate-rows tr').first().locator('[data-margin]');
  await expect(figure).toHaveText('R9 300,00 (77,5%)');
  await expect(figure).toHaveAttribute('data-margin', 'ok');
});

test('a sourcing post drafted in the demo carries the scope and not the client, and an edit naming them is refused', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  await page.getByLabel('Platform').selectOption('upwork');
  await page.getByRole('button', { name: 'Draft a post' }).click();
  await expect(page.locator('#posts-status')).toContainText('Drafted the Upwork post');
  const card = page.locator('#posts article');
  await expect(card).toContainText('Wordpress: An online shop for our customers (sample)');
  await expect(card).toContainText('- Take orders');
  await expect(card).not.toContainText('acme-shop');
  await expect(card).not.toContainText('R10 000');
  await page.getByRole('button', { name: 'Edit the Upwork post' }).click();
  await page.getByLabel('Post text').fill('Built for acme-shop (sample)');
  await page.getByRole('button', { name: 'Save the Upwork post' }).click();
  await expect(page.locator('[id$="-body-error"]')).toHaveText('Contains the client’s handle.');
});

test('a sourcing post drafted in the demo waits on the approvals page and is approved there', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  await page.getByLabel('Platform').selectOption('fiverr');
  await page.getByRole('button', { name: 'Draft a post' }).click();
  await expect(page.locator('#posts-status')).toContainText('Drafted the Fiverr post');
  await page.goto('/approvals.html');
  await expect(page.locator('#status')).toContainText('1 sourcing post');
  const card = page.locator('#list article[data-kind="post"]');
  await expect(card).toContainText('Sourcing post on Fiverr');
  await page
    .getByRole('button', { name: 'Approve the Fiverr post for Shopify store rebuild (sample)' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Approved the Fiverr post for Shopify store rebuild (sample).',
  );
  await expect(card).toHaveCount(0);
});

test('choosing a supplier in the demo opens a delivery order whose milestones must reconcile before it is assigned', async ({
  page,
}) => {
  await page.goto('/sourcing.html');
  await page
    .getByRole('button', { name: 'Open the sourcing request for Shopify store rebuild (sample)' })
    .click();
  await page.getByRole('button', { name: 'Choose Thandi Web (sample) as the supplier' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Choose' }).click();
  await page.getByRole('link', { name: 'Open the delivery order' }).click();
  await expect(page.locator('#delivery-status')).toHaveText(
    'Opened the delivery order for Shopify store rebuild (sample).',
  );
  await expect(page.locator('#delivery-figures')).toContainText('R1 500,00');
  // Split the R1 500,00 into R500,00 + R900,00 = R1 400,00: refused on the page.
  await page.getByRole('button', { name: 'Add a milestone' }).click();
  await page.getByLabel('Milestone 1 amount').fill('500.00');
  await page.getByLabel('Milestone 2 title').fill('Second half');
  await page.getByLabel('Milestone 2 amount').fill('900.00');
  await page.getByRole('button', { name: 'Save cost and milestones' }).click();
  await expect(page.locator('#order-milestones-error')).toContainText('They must be equal.');
  await page.getByLabel('Milestone 2 amount').fill('1000.00');
  await page.getByRole('button', { name: 'Save cost and milestones' }).click();
  await expect(page.locator('#delivery-status')).toHaveText('Saved the cost and milestones.');
  await page.getByRole('button', { name: 'Assign the supplier' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Assign' }).click();
  await expect(page.locator('#delivery-status')).toHaveText('Assigned the supplier.');
  await expect(page.getByRole('button', { name: 'Start the work' })).toBeDisabled();
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('delivery.status_changed');
});

test('a payment recorded in the demo is worked into realised margin by the real rule', async ({
  page,
}) => {
  await page.goto('/pipeline.html');
  await page
    .getByRole('button', { name: 'Open the payments for Shopify store rebuild (sample)' })
    .click();
  await expect(page.locator('#payments-empty')).toBeVisible();
  // R12 000,00 in from the client; R1 200,00 platform fee out: margin R10 800,00.
  await page.getByLabel('Amount', { exact: true }).fill('12000.00');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click();
  await expect(page.locator('#payments-status')).toHaveText(
    'Recorded the client payment of R12 000,00.',
  );
  await expect(page.locator('#payments-meta')).toContainText('paid in full');
  await page.getByLabel('What', { exact: true }).selectOption('platform_fee');
  await page.getByLabel('Amount', { exact: true }).fill('1200.00');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click();
  await expect(page.locator('#margin-figures')).toContainText('Realised marginR10 800,00');
  await expect(page.locator('#board section[data-stage="paid"]')).toContainText(
    'Shopify store rebuild (sample)',
  );
});

test('a variant added in the demo starts at no data, and a sent variant’s words stay locked', async ({
  page,
}) => {
  await page.goto('/templates.html');
  const sample = page.getByRole('region', { name: 'Website builds (sample)' });
  // The tab's sent bid was written from variant A.
  await expect(sample.locator('tbody tr').nth(0)).toContainText('of 1)');
  await sample.getByRole('button', { name: 'Edit variant A' }).click();
  await expect(sample.getByLabel('Words', { exact: true }).first()).toBeDisabled();
  await sample.getByLabel('Label', { exact: true }).last().fill('C');
  await sample.getByLabel('Words', { exact: true }).last().fill('Open with the deadline.');
  await sample.getByRole('button', { name: 'Add the variant' }).click();
  await expect(page.locator('#status')).toHaveText('Added variant C to “Website builds (sample)”.');
  await expect(sample.locator('tbody tr').nth(2)).toContainText('No data (0 of 0)');
  await page.goto('/audit-log.html');
  await expect(page.locator('#rows tr').first()).toContainText('template.variant_created');
});

test('the dashboard’s retainer total follows the pipeline’s retainer toggle', async ({ page }) => {
  await page.goto('/dashboard.html');
  await expect(page.locator('#retainers')).toHaveText('R4 500,00');
  await page.goto('/pipeline.html');
  await page.getByLabel('Retainer for Shopify store rebuild (sample)', { exact: true }).check();
  await page.getByLabel('Monthly amount for Shopify store rebuild (sample)').fill('1000.00');
  await page
    .getByRole('button', { name: 'Save the retainer for Shopify store rebuild (sample)' })
    .click();
  await expect(page.locator('#status')).toHaveText(
    'Shopify store rebuild (sample) is a retainer of R1 000,00 a month.',
  );
  // R4 500,00 + R1 000,00 = R5 500,00 over two active retainers.
  await page.goto('/dashboard.html');
  await expect(page.locator('#retainers')).toHaveText('R5 500,00');
  await expect(page.locator('#retainers-note')).toHaveText('2 active retainers, monthly total.');
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

test('connecting Upwork in the demo returns at once with a sample account, to read jobs only', async ({
  page,
}) => {
  await page.goto('/settings.html');
  await expect(page.locator('#connect-upwork-hint')).toContainText('Nothing reaches Upwork.');
  await page.getByRole('button', { name: 'Connect Upwork' }).click();
  await expect(page).toHaveURL(/\/upwork-callback\.html$/);
  await expect(page.locator('#status')).toHaveText(
    'Connected the Upwork account Sample Upwork account (demo). It is used to read jobs only.',
  );
});
