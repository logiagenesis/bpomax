import { expect, test } from '@playwright/test';
import {
  ANON_KEY,
  API,
  SESSION,
  SUPABASE,
  expectNoSidewaysScroll,
  me,
  signedIn,
} from './helpers.js';

/**
 * ARB-061: the login page. Supabase Auth is answered at the network edge with the
 * shapes its password grant returns; the API's `POST /v1/sessions` likewise.
 */
interface AuthOptions {
  tokenStatus?: number;
  sessionStatus?: number;
}

async function serveAuth(page: import('@playwright/test').Page, options: AuthOptions = {}) {
  const requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  await page.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: request.postDataJSON(),
    });
    const status = options.tokenStatus ?? 200;
    if (status !== 200) {
      await route.fulfill({
        status,
        json: { code: status, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
      });
      return;
    }
    await route.fulfill({ json: { ...SESSION, token_type: 'bearer', expires_in: 3600 } });
  });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: null,
    });
    const status = options.sessionStatus ?? 201;
    if (status !== 201) {
      await route.fulfill({ status, json: { error: 'you are not a member of an organisation' } });
      return;
    }
    await route.fulfill({ status, json: me() });
  });
  return requests;
}

test('renders the form with labelled fields and a working brand link', async ({ page }) => {
  await page.goto('/login.html');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Arbitron' })).toHaveAttribute(
    'href',
    './index.html',
  );
});

test('refuses an empty or malformed form before anything is sent', async ({ page }) => {
  const requests = await serveAuth(page);
  await page.goto('/login.html');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#email-error')).toHaveText('Is required.');
  await expect(page.locator('#password-error')).toHaveText('Is required.');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.getByLabel('Email').fill('not-an-address');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#email-error')).toHaveText('Must be an email address.');
  await expect(page.locator('#status')).toHaveText(
    'Some fields need attention. The first one has been selected.',
  );
  expect(requests).toHaveLength(0);
});

test('signs in with the password grant, tells the API, and opens the dashboard', async ({
  page,
}) => {
  const requests = await serveAuth(page);
  await page.goto('/login.html');
  await page.getByLabel('Email').fill('ayanda@example.com');
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard.html');

  const token = requests.find((r) => r.url.includes('/auth/v1/token'));
  expect(token?.url).toBe(`${SUPABASE}/auth/v1/token?grant_type=password`);
  expect(token?.method).toBe('POST');
  expect(token?.headers['apikey']).toBe(ANON_KEY);
  expect(token?.body).toEqual({ email: 'ayanda@example.com', password: 'correct horse' });

  const session = requests.find((r) => r.url === `${API}/v1/sessions`);
  expect(session?.method).toBe('POST');
  expect(session?.headers['authorization']).toBe(`Bearer ${SESSION.access_token}`);

  const stored = await page.evaluate(() => sessionStorage.getItem('arbitron.session'));
  expect(JSON.parse(stored ?? '{}').access_token).toBe(SESSION.access_token);
});

test('honours a next page of this app, and ignores anything else', async ({ page }) => {
  await serveAuth(page);
  await page.goto('/login.html?next=feed.html');
  await page.getByLabel('Email').fill('ayanda@example.com');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/feed.html');

  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/login.html?next=https://evil.example/steal.html');
  await page.getByLabel('Email').fill('ayanda@example.com');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard.html');
});

test('says plainly when the password is wrong, and keeps no session', async ({ page }) => {
  await serveAuth(page, { tokenStatus: 400 });
  await page.goto('/login.html');
  await page.getByLabel('Email').fill('ayanda@example.com');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Email or password is wrong. Check both and try again.',
  );
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
  expect(await page.evaluate(() => sessionStorage.getItem('arbitron.session'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('a valid login with no membership is turned away and the session dropped', async ({
  page,
}) => {
  await serveAuth(page, { sessionStatus: 403 });
  await page.goto('/login.html');
  await page.getByLabel('Email').fill('stranger@example.com');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Signed in, but this account is not a member of an organisation. Ask an owner to add you.',
  );
  expect(await page.evaluate(() => sessionStorage.getItem('arbitron.session'))).toBeNull();
  await expect(page).toHaveURL(/login\.html/);
});

test('an unreachable sign-in service is reported, not hidden', async ({ page }) => {
  await page.route(`${SUPABASE}/**`, (route) => route.abort('connectionrefused'));
  await page.goto('/login.html');
  await page.getByLabel('Email').fill('ayanda@example.com');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Could not reach the sign-in service. Check your connection and try again.',
  );
});

test('someone already signed in is sent on, not shown the form', async ({ page }) => {
  await signedIn(page);
  await page.goto('/login.html');
  await page.waitForURL('**/dashboard.html');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/login.html');
  await expectNoSidewaysScroll(page);
});
