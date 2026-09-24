import { expect, test } from '@playwright/test';
import {
  API,
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  me,
  serveApi,
  signedIn,
} from './helpers.js';

/**
 * ARB-400: onboarding. Someone signed in but in no organisation creates one; a member
 * sees what is left to set up. The API is answered at the network edge in the shapes
 * `POST /v1/orgs` and `GET /v1/onboarding` return (apps/api/src/routes/orgs.test.ts).
 */
function steps(done: string[] = ['org']) {
  const all = [
    ['org', 'Create your organisation', 'settings.html', false],
    ['margin', 'Set your margin rules and fee table', 'settings.html#rules-heading', false],
    ['freelancer', 'Connect Freelancer.com', 'settings.html#accounts-heading', false],
    ['scanner', 'Add a saved search', 'settings.html#scanners-heading', false],
    ['template', 'Add a bid template', 'templates.html', false],
    ['telegram', 'Link Telegram', 'settings.html#telegram-heading', true],
  ] as const;
  return all.map(([key, title, href, optional]) => ({
    key,
    title,
    detail: `Why ${key} matters.`,
    href,
    done: done.includes(key),
    optional,
  }));
}

const NO_ORG = { status: 403, json: { error: 'you are not a member of an organisation' } };

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('someone in no organisation is offered the form, and nothing else', async ({ page }) => {
  await serveApi(page, {
    'GET /v1/me': (_r, route) => route.fulfill(NO_ORG),
    'GET /v1/onboarding': (_r, route) => route.fulfill(NO_ORG),
  });
  await page.goto('/onboarding.html');
  await expect(page.getByRole('heading', { name: 'Create your organisation' })).toBeVisible();
  await expect(page.getByLabel('Organisation name')).toBeFocused();
  await expect(page.getByLabel('Country')).toHaveValue('ZA');
  await expect(page.locator('#steps')).toBeHidden();
  await expect(page.locator('#who')).toHaveText('ayanda@example.com');
});

test('a signed-in page sends someone in no organisation here', async ({ page }) => {
  await serveApi(page, {
    'GET /v1/me': (_r, route) => route.fulfill(NO_ORG),
    'GET /v1/onboarding': (_r, route) => route.fulfill(NO_ORG),
  });
  await page.goto('/dashboard.html');
  await page.waitForURL('**/onboarding.html');
});

test('checks the form before sending it', async ({ page }) => {
  const captured = await serveApi(page, {
    'GET /v1/onboarding': (_r, route) => route.fulfill(NO_ORG),
  });
  await page.goto('/onboarding.html');
  await page.getByLabel('Country').fill('Z1');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.locator('#name-error')).toHaveText('Is required.');
  await expect(page.locator('#countryCode-error')).toHaveText(
    'Must be a two-letter ISO 3166-1 code, such as ZA.',
  );
  expect(captured.filter((c) => c.path === '/v1/orgs')).toHaveLength(0);
});

test('creates the organisation, records the sign-in, then lists the steps', async ({ page }) => {
  let member = false;
  const captured = await serveApi(page, {
    'GET /v1/onboarding': (_r, route) =>
      member
        ? route.fulfill({
            json: { ...me(), org: { ...me().org, name: 'New Studio' }, steps: steps() },
          })
        : route.fulfill(NO_ORG),
    'POST /v1/orgs': (_r, route) => {
      member = true;
      return route.fulfill({
        status: 201,
        json: { ...me(), org: { ...me().org, name: 'New Studio' } },
      });
    },
    'POST /v1/sessions': (_r, route) => route.fulfill({ status: 201, json: me() }),
  });
  await page.goto('/onboarding.html');
  await page.getByLabel('Organisation name').fill('  New Studio ');
  await page.getByLabel('Country').fill('za');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.locator('#status')).toHaveText('New Studio is created, and you are its owner.');

  const create = captured.find((c) => c.path === '/v1/orgs');
  expect(create?.method).toBe('POST');
  expect(create?.body).toEqual({ name: 'New Studio', countryCode: 'ZA' });
  expect(create?.auth).toBe('Bearer e2e-access-token');
  expect(captured.some((c) => c.path === '/v1/sessions' && c.method === 'POST')).toBe(true);

  await expect(page.locator('#create-org')).toBeHidden();
  await expect(page.locator('#steps-summary')).toHaveText('New Studio: 4 of 5 steps left.');
  await expect(page.locator('#who')).toHaveText('Ayanda Nkosi · owner · New Studio');
});

test('a refusal from the API is shown as it is', async ({ page }) => {
  await serveApi(page, {
    'GET /v1/onboarding': (_r, route) => route.fulfill(NO_ORG),
    'POST /v1/orgs': (_r, route) =>
      route.fulfill({
        status: 409,
        json: { error: 'You are already a member of an organisation. Sign in to use it.' },
      }),
  });
  await page.goto('/onboarding.html');
  await page.getByLabel('Organisation name').fill('Another');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.locator('#status')).toHaveText(
    'You are already a member of an organisation. Sign in to use it.',
  );
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
});

test('a member sees each step, ticked from the org s rows, each linked to its page', async ({
  page,
}) => {
  await serveApi(page, {
    'GET /v1/onboarding': (_r, route) =>
      route.fulfill({ json: { ...me(), steps: steps(['org', 'margin', 'template']) } }),
  });
  await page.goto('/onboarding.html');
  await expect(page.locator('#create-org')).toBeHidden();
  await expect(page.locator('#step-list li')).toHaveCount(6);
  await expect(page.locator('#step-list .badge')).toHaveText([
    'Done',
    'Done',
    'To do',
    'To do',
    'Done',
    'Optional',
  ]);
  await expect(page.getByRole('link', { name: 'Connect Freelancer.com' })).toHaveAttribute(
    'href',
    './settings.html#accounts-heading',
  );
  await expect(page.locator('#steps-summary')).toHaveText('Logi-Ink: 2 of 5 steps left.');
  await expectEveryLinkGoesSomewhere(page);
});

test('says when everything required is done', async ({ page }) => {
  await serveApi(page, {
    'GET /v1/onboarding': (_r, route) =>
      route.fulfill({
        json: { ...me(), steps: steps(['org', 'margin', 'freelancer', 'scanner', 'template']) },
      }),
  });
  await page.goto('/onboarding.html');
  await expect(page.locator('#steps-summary')).toHaveText(
    'Logi-Ink is set up. Everything below is done, apart from anything marked optional.',
  );
});

test('an expired session goes back to login', async ({ page }) => {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 401, json: { error: 'x' } }));
  await page.goto('/onboarding.html');
  await page.waitForURL('**/login.html?next=onboarding.html');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await serveApi(page, {
    'GET /v1/onboarding': (_r, route) => route.fulfill({ json: { ...me(), steps: steps() } }),
  });
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/onboarding.html');
  await expect(page.locator('#steps')).toBeVisible();
  await expectNoSidewaysScroll(page);
});
