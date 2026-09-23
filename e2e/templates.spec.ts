import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Captured,
  type Role,
} from './helpers.js';

/**
 * ARB-340: the templates page. The API is an in-memory copy, at the network edge, of
 * apps/api/src/routes/templates.ts (tested against real Postgres and raw SQL in
 * routes/templates.test.ts); the figures are the ones hand-worked there: variant A 2 of 3
 * = 66,7 %, variant B 0 of 1 = 0,0 %, the template 2 of 4 = 50,0 %.
 */
const WEB = 'aaaaaaaa-0000-4000-8000-000000000301';
const GENERAL = 'aaaaaaaa-0000-4000-8000-000000000302';
const A = 'aaaaaaaa-0000-4000-8000-000000000311';
const B = 'aaaaaaaa-0000-4000-8000-000000000312';
const ONLY = 'aaaaaaaa-0000-4000-8000-000000000313';

const ratio = (numerator: number, denominator: number, percent: string | null) => ({
  numerator,
  denominator,
  percent,
});
const LOCK = (n: number) =>
  `This variant has been sent ${String(n)} times, and its reply rate measures these words. Add a new variant with the new words, and switch this one off if it should stop.`;

type Variant = {
  id: string;
  label: string;
  body: string;
  active: boolean;
  sends: number;
  replies: number;
  replyRate: ReturnType<typeof ratio>;
  wordsLocked: string | null;
};
type Template = {
  id: string;
  name: string;
  categorySlug: string | null;
  categoryName: string | null;
  description: string | null;
  active: boolean;
  variants: Variant[];
  sends: number;
  replies: number;
  replyRate: ReturnType<typeof ratio>;
};

function sample(): Template[] {
  return [
    {
      id: WEB,
      name: 'Web rebuild',
      categorySlug: 'web-design',
      categoryName: 'Web design',
      description: 'For site rebuilds',
      active: true,
      variants: [
        {
          id: A,
          label: 'A',
          body: 'Open with the outcome.',
          active: true,
          sends: 3,
          replies: 2,
          replyRate: ratio(2, 3, '66.7'),
          wordsLocked: LOCK(3),
        },
        {
          id: B,
          label: 'B',
          body: 'Open with a question.',
          active: true,
          sends: 1,
          replies: 0,
          replyRate: ratio(0, 1, '0.0'),
          wordsLocked: LOCK(1).replace('1 times', '1 time'),
        },
      ],
      sends: 4,
      replies: 2,
      replyRate: ratio(2, 4, '50.0'),
    },
    {
      id: GENERAL,
      name: 'General',
      categorySlug: null,
      categoryName: null,
      description: null,
      active: true,
      variants: [
        {
          id: ONLY,
          label: 'Only',
          body: 'Words Only',
          active: true,
          sends: 0,
          replies: 0,
          replyRate: ratio(0, 0, null),
          wordsLocked: null,
        },
      ],
      sends: 0,
      replies: 0,
      replyRate: ratio(0, 0, null),
    },
  ];
}

const refuse = (field: string, message: string) => ({
  status: 422,
  json: { error: 'the request was not accepted', errors: [{ field, message }] },
});

async function open(
  page: Page,
  options: { role?: Role; none?: boolean } = {},
): Promise<Captured[]> {
  await signedIn(page);
  const templates = options.none ? [] : sample();
  const requests = await serveApi(
    page,
    {
      'GET /v1/service-categories': (_req, route) =>
        route.fulfill({
          json: {
            categories: [
              { slug: 'web-design', name: 'Web design', inHouse: true },
              { slug: 'seo', name: 'SEO', inHouse: false },
            ],
          },
        }),
      'GET /v1/templates': (_req, route) => route.fulfill({ json: { templates } }),
      'POST /v1/templates': (req, route) => {
        const body = req.body as { name: string; categorySlug: string; description: string };
        if (templates.some((t) => t.name === body.name.trim()))
          return route.fulfill(refuse('name', 'is already used by another template'));
        const t: Template = {
          id: 'aaaaaaaa-0000-4000-8000-000000000399',
          name: body.name.trim(),
          categorySlug: body.categorySlug || null,
          categoryName: body.categorySlug === 'seo' ? 'SEO' : null,
          description: body.description.trim() || null,
          active: true,
          variants: [],
          sends: 0,
          replies: 0,
          replyRate: ratio(0, 0, null),
        };
        templates.unshift(t);
        return route.fulfill({ status: 201, json: { template: t } });
      },
      'PATCH /v1/templates/:id': (req, route) => {
        const t = templates.find((x) => req.path.endsWith(x.id))!;
        const body = req.body as Partial<Template>;
        Object.assign(t, {
          ...body,
          ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        });
        return route.fulfill({ json: { template: t } });
      },
      'POST /v1/templates/:id/variants': (req, route) => {
        const t = templates.find((x) => req.path.includes(x.id))!;
        const body = req.body as { label: string; body: string };
        if (t.variants.some((v) => v.label === body.label.trim()))
          return route.fulfill(refuse('label', 'is already used in this template'));
        t.variants.push({
          id: 'aaaaaaaa-0000-4000-8000-000000000398',
          label: body.label.trim(),
          body: body.body.trim(),
          active: true,
          sends: 0,
          replies: 0,
          replyRate: ratio(0, 0, null),
          wordsLocked: null,
        });
        return route.fulfill({ status: 201, json: { template: t } });
      },
      'PATCH /v1/template-variants/:id': (req, route) => {
        const t = templates.find((x) => x.variants.some((v) => req.path.endsWith(v.id)))!;
        const v = t.variants.find((x) => req.path.endsWith(x.id))!;
        const body = req.body as Partial<Variant>;
        if (body.body !== undefined && v.wordsLocked)
          return route.fulfill({ status: 409, json: { error: v.wordsLocked } });
        Object.assign(v, body);
        return route.fulfill({ json: { template: t } });
      },
    },
    { role: options.role },
  );
  await page.goto('/templates.html');
  await expectStatus(page, /^Showing \d+ templates?\.$|^No templates yet\.$/);
  return requests;
}

const card = (page: Page, name: string): Locator => page.getByRole('region', { name });
const last = (requests: Captured[], method: string) =>
  requests.filter((r) => r.method === method).at(-1);

test('shows each variant’s rate as the API worked it, the template’s total, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Showing 2 templates.');
  const web = card(page, 'Web rebuild');
  await expect(web.locator('p').filter({ hasText: 'Reply rate:' })).toHaveText(
    'Reply rate: 50,0 % (2 of 4), from 4 bids sent.',
  );
  await expect(web).toContainText('Web design · For site rebuilds');
  await expect(web).toContainText('2 variants are switched on and take turns.');
  const rows = web.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(
    /A\s*Open with the outcome\.\s*66,7 % \(2 of 3\)\s*3\s*2\s*On/,
  );
  await expect(rows.nth(1)).toHaveText(
    /B\s*Open with a question\.\s*0,0 % \(0 of 1\)\s*1\s*0\s*On/,
  );
  const general = card(page, 'General');
  await expect(general).toContainText('General: for a job whose category has no template');
  await expect(general.locator('tbody tr')).toContainText('No data (0 of 0)');
  await expect(general).toContainText(
    'One variant is switched on. Add a second to compare two versions.',
  );
  await expect(page.locator('#count')).toHaveText('2 templates, 3 variants.');
  await expect(page.getByRole('link', { name: 'Templates' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('Create the template checks the fields first, then sends what was typed and shows the new template', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Create the template' }).click();
  await expect(page.locator('#new-name-error')).toHaveText('Must not be blank.');
  await expect(page.locator('#new-name')).toBeFocused();
  expect(last(requests, 'POST')).toBeUndefined();

  await page.locator('#new-name').fill('  SEO audits ');
  await page.locator('#new-categorySlug').selectOption('seo');
  await page.locator('#new-description').fill('Short audits');
  await page.getByRole('button', { name: 'Create the template' }).click();
  await expectStatus(page, 'Created “SEO audits”. Add its first variant below.');
  expect(last(requests, 'POST')?.body).toEqual({
    name: '  SEO audits ',
    categorySlug: 'seo',
    description: 'Short audits',
  });
  const created = card(page, 'SEO audits');
  await expect(created).toContainText('No variants yet: add the first below.');
  await expect(created).toContainText(
    'No variant is switched on, so no bid is drafted from this template.',
  );
  await expect(page.locator('#new-name')).toHaveValue('');
});

test('a name already used comes back on its field', async ({ page }) => {
  await open(page);
  await page.locator('#new-name').fill('General');
  await page.getByRole('button', { name: 'Create the template' }).click();
  await expect(page.locator('#new-name-error')).toHaveText('Is already used by another template.');
  await expectStatus(page, 'Some fields need attention. The first one has been selected.');
});

test('Edit the template saves the changes, and the template can be switched off and on', async ({
  page,
}) => {
  const requests = await open(page);
  const web = card(page, 'Web rebuild');
  await web.getByRole('button', { name: 'Edit the template' }).click();
  const name = page.locator(`#t-${WEB}-name`);
  await expect(name).toBeFocused();
  await name.fill('Web rebuilds');
  await page.locator(`#t-${WEB}-categorySlug`).selectOption('');
  await page.getByRole('button', { name: 'Save the template' }).click();
  await expectStatus(page, 'Saved “Web rebuilds”.');
  expect(last(requests, 'PATCH')).toMatchObject({
    path: `/v1/templates/${WEB}`,
    body: { name: 'Web rebuilds', categorySlug: '', description: 'For site rebuilds' },
  });

  const renamed = card(page, 'Web rebuilds');
  await renamed.getByRole('button', { name: 'Switch the template off' }).click();
  await expectStatus(page, 'Switched off “Web rebuilds”; no bid is drafted from it.');
  expect(last(requests, 'PATCH')?.body).toEqual({ active: false });
  await expect(renamed).toContainText('Switched off');
  await renamed.getByRole('button', { name: 'Switch the template on' }).click();
  await expectStatus(page, 'Switched on “Web rebuilds”; bids are drafted from it again.');
});

test('Add the variant checks its fields, refuses a label already used, and adds the row', async ({
  page,
}) => {
  const requests = await open(page);
  const web = card(page, 'Web rebuild');
  await web.getByRole('button', { name: 'Add the variant' }).click();
  await expect(page.locator(`#t-${WEB}-new-label-error`)).toHaveText('Must not be blank.');
  await expect(page.locator(`#t-${WEB}-new-body-error`)).toHaveText('Must not be blank.');
  expect(last(requests, 'POST')).toBeUndefined();

  await page.locator(`#t-${WEB}-new-label`).fill('B');
  await page.locator(`#t-${WEB}-new-body`).fill('Open with a price.');
  await web.getByRole('button', { name: 'Add the variant' }).click();
  await expect(page.locator(`#t-${WEB}-new-label-error`)).toHaveText(
    'Is already used in this template.',
  );

  await page.locator(`#t-${WEB}-new-label`).fill('C');
  await web.getByRole('button', { name: 'Add the variant' }).click();
  await expectStatus(page, 'Added variant C to “Web rebuild”.');
  expect(last(requests, 'POST')).toMatchObject({
    path: `/v1/templates/${WEB}/variants`,
    body: { label: 'C', body: 'Open with a price.' },
  });
  await expect(web.locator('tbody tr')).toHaveCount(3);
  await expect(web.locator('tbody tr').nth(2)).toContainText('No data (0 of 0)');
  await expect(web).toContainText('3 variants are switched on and take turns.');
});

test('a sent variant’s words are locked; its label still changes, and a variant can be switched off', async ({
  page,
}) => {
  const requests = await open(page);
  const web = card(page, 'Web rebuild');
  await web.getByRole('button', { name: 'Edit variant A' }).click();
  await expect(page.locator(`#t-${WEB}-variant-heading`)).toHaveText('Edit variant A');
  await expect(page.locator(`#t-${WEB}-variant-label`)).toBeFocused();
  await expect(page.locator(`#t-${WEB}-variant-body`)).toBeDisabled();
  await expect(page.locator(`#t-${WEB}-variant-body-hint`)).toHaveText(LOCK(3));
  await page.locator(`#t-${WEB}-variant-label`).fill('A1');
  await page.getByRole('button', { name: 'Save the variant' }).click();
  await expectStatus(page, 'Saved variant A1.');
  // Only the label is sent: the locked words are not.
  expect(last(requests, 'PATCH')).toMatchObject({
    path: `/v1/template-variants/${A}`,
    body: { label: 'A1' },
  });
  expect(last(requests, 'PATCH')?.body).not.toHaveProperty('body');

  await web.getByRole('button', { name: 'Switch off variant B' }).click();
  await expectStatus(
    page,
    'Switched off variant B; bids are drafted from the other switched-on variants.',
  );
  expect(last(requests, 'PATCH')).toMatchObject({
    path: `/v1/template-variants/${B}`,
    body: { active: false },
  });
  await expect(web.locator('tbody tr').nth(1)).toContainText('Off');
  await expect(web).toContainText(
    'One variant is switched on. Add a second to compare two versions.',
  );
});

test('an unsent variant’s words can change; Cancel closes the form', async ({ page }) => {
  const requests = await open(page);
  const general = card(page, 'General');
  await general.getByRole('button', { name: 'Edit variant Only' }).click();
  const body = page.locator(`#t-${GENERAL}-variant-body`);
  await expect(body).toBeEnabled();
  await expect(page.locator(`#t-${GENERAL}-variant-body-hint`)).toHaveText(
    'The words the model starts a bid from.',
  );
  await general.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator(`#t-${GENERAL}-variant-form`)).toBeHidden();
  await expect(general.getByRole('button', { name: 'Edit variant Only' })).toBeFocused();

  await general.getByRole('button', { name: 'Edit variant Only' }).click();
  await body.fill('Better words.');
  await page.getByRole('button', { name: 'Save the variant' }).click();
  await expectStatus(page, 'Saved variant Only.');
  expect(last(requests, 'PATCH')).toMatchObject({
    path: `/v1/template-variants/${ONLY}`,
    body: { label: 'Only', body: 'Better words.' },
  });
});

test('Edit the template works from the keyboard', async ({ page }) => {
  const requests = await open(page);
  await card(page, 'General').getByRole('button', { name: 'Edit the template' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#t-${GENERAL}-name`)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' bids');
  await page.keyboard.press('Enter');
  await expectStatus(page, 'Saved “General bids”.');
  expect(last(requests, 'PATCH')?.body).toMatchObject({ name: 'General bids' });
});

test('a viewer reads the figures, and every change is disabled with the reason', async ({
  page,
}) => {
  await open(page, { role: 'viewer' });
  const reason = 'Your role can view templates but not change them.';
  const create = page.getByRole('button', { name: 'Create the template' });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', reason);
  await expect(page.locator('#new-name')).toBeDisabled();
  const web = card(page, 'Web rebuild');
  await expect(web.locator('tbody tr').nth(0)).toContainText('66,7 % (2 of 3)');
  for (const name of [
    'Edit the template',
    'Switch the template off',
    'Edit variant A',
    'Switch off variant A',
    'Add the variant',
  ]) {
    const button = web.getByRole('button', { name });
    await expect(button, name).toBeDisabled();
    await expect(button, name).toHaveAttribute('title', reason);
  }
});

test('with no templates, the page says a bid needs one', async ({ page }) => {
  await open(page, { none: true });
  await expectStatus(page, 'No templates yet.');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toContainText('A bid is drafted only from a template');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});
