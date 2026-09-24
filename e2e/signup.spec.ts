import { expect, test, type Page } from '@playwright/test';
import {
  ANON_KEY,
  SESSION,
  SUPABASE,
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  signedIn,
} from './helpers.js';

/**
 * ARB-400: the sign-up page and the terms of service page. Supabase Auth's sign-up is
 * answered at the network edge in the shapes `POST /auth/v1/signup` returns (a user
 * alone when the project asks for email confirmation, a session when it does not). The
 * committed terms are pending (D-068), so the first cases run against the real file and
 * the rest answer `terms.json` with what an owner might publish. The wording in them is
 * placeholder text for the test, not terms.
 */
const APPROVED = {
  status: 'approved',
  approvedBy: 'Approver name',
  approvedOn: '2026-10-01',
  version: 'v1',
  sections: [{ heading: 'Heading one', paragraphs: ['Paragraph one.'] }],
};

async function serveTerms(page: Page, body: unknown = APPROVED, status = 200): Promise<void> {
  await page.route('**/terms.json', (route) =>
    route.fulfill({ status, json: body as Record<string, unknown> }),
  );
}

interface SignupCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

async function serveSignup(
  page: Page,
  answer: { status?: number; json?: unknown } = {},
): Promise<SignupCall[]> {
  const calls: SignupCall[] = [];
  await page.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request();
    calls.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
    await route.fulfill({
      status: answer.status ?? 200,
      json: (answer.json ?? {
        id: 'bbbbbbbb-0000-4000-8000-000000000003',
        aud: 'authenticated',
        email: 'thandi@example.com',
        email_confirmed_at: null,
      }) as Record<string, unknown>,
    });
  });
  return calls;
}

async function fill(page: Page, password = 'a long passphrase', confirm = password) {
  await page.getByLabel('Email').fill('thandi@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password again').fill(confirm);
}

test.describe('while the terms are pending', () => {
  test('sign-up is closed, says why, and sends nothing', async ({ page }) => {
    const calls = await serveSignup(page);
    await page.goto('/signup.html');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    await expect(page.locator('#status')).toHaveText(
      'Sign-up opens once the terms of service are published. Until then, an owner can add you to their organisation.',
    );
    await expect(page.getByRole('button', { name: 'Create account' })).toBeDisabled();
    await expect(page.getByLabel('Email')).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  test('the terms page says they are pending, names D-16, and shows no wording', async ({
    page,
  }) => {
    await page.goto('/terms.html');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
    await expect(page.locator('#terms-pending')).toContainText('D-16');
    await expect(page.locator('#terms')).toBeHidden();
    await expectEveryLinkGoesSomewhere(page);
  });
});

test.describe('once the terms are approved', () => {
  test.beforeEach(async ({ page }) => {
    await serveTerms(page);
  });

  test('the terms page shows them with who approved them and when', async ({ page }) => {
    await page.goto('/terms.html');
    await expect(page.locator('#terms-approval')).toHaveText(
      'Version v1, approved by Approver name on 01/10/2026.',
    );
    await expect(page.locator('#terms h2')).toHaveText(['Heading one']);
  });

  test('the form names the version being accepted', async ({ page }) => {
    await page.goto('/signup.html');
    await expect(page.locator('#terms-label')).toHaveText(
      'I accept the terms of service (version v1, approved 01/10/2026)',
    );
    await expect(page.getByRole('link', { name: 'terms of service' })).toHaveAttribute(
      'href',
      './terms.html',
    );
    await expectEveryLinkGoesSomewhere(page);
  });

  test('refuses an incomplete form before anything is sent', async ({ page }) => {
    const calls = await serveSignup(page);
    await page.goto('/signup.html');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#email-error')).toHaveText('Is required.');
    await expect(page.locator('#password-error')).toHaveText('Is required.');
    await expect(page.locator('#terms-error')).toHaveText('Must be accepted to create an account.');
    await expect(page.getByLabel('Email')).toBeFocused();

    await fill(page, 'one passphrase', 'another passphrase');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#confirm-error')).toHaveText('Must match the password.');
    expect(calls).toHaveLength(0);
  });

  test('signs up with the documented request and, when confirmation is on, says to check email', async ({
    page,
  }) => {
    const calls = await serveSignup(page);
    await page.goto('/signup.html');
    await fill(page);
    await page.getByLabel(/I accept the/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#status')).toHaveText(
      'Check your email: a confirmation link is on its way to thandi@example.com. Open it, then sign in to set up your organisation.',
    );
    await expect(page.getByRole('button', { name: 'Create account' })).toBeDisabled();

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${SUPABASE}/auth/v1/signup`);
    expect(url.searchParams.get('redirect_to')).toMatch(/\/login\.html$/);
    expect(calls[0]!.headers['apikey']).toBe(ANON_KEY);
    const body = calls[0]!.body as {
      email: string;
      password: string;
      data: { terms_version: string; terms_accepted_at: string };
    };
    expect(body.email).toBe('thandi@example.com');
    expect(body.password).toBe('a long passphrase');
    expect(body.data.terms_version).toBe('v1');
    expect(Number.isNaN(Date.parse(body.data.terms_accepted_at))).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('arbitron.session'))).toBeNull();
  });

  test('when the project signs people in straight away, keeps the session and opens onboarding', async ({
    page,
  }) => {
    await serveSignup(page, {
      json: { ...SESSION, token_type: 'bearer', expires_in: 3600 },
    });
    await page.route('https://e2e-api.invalid/**', (route) =>
      route.fulfill({ status: 403, json: { error: 'you are not a member of an organisation' } }),
    );
    await page.goto('/signup.html');
    await fill(page);
    await page.getByLabel(/I accept the/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/onboarding.html');
    const stored = await page.evaluate(() => sessionStorage.getItem('arbitron.session'));
    expect(JSON.parse(stored ?? '{}').access_token).toBe(SESSION.access_token);
  });

  for (const [code, status, field, message] of [
    [
      'user_already_exists',
      422,
      null,
      'An account already uses this email address. Sign in instead.',
    ],
    [
      'over_email_send_rate_limit',
      429,
      null,
      'Too many sign-up emails have been sent. Try again in a few minutes.',
    ],
    ['signup_disabled', 422, null, 'Sign-up is switched off on this service.'],
    [
      'weak_password',
      422,
      '#password-error',
      'Is too weak: Password should be at least 6 characters.',
    ],
    ['email_address_invalid', 400, '#email-error', 'Is not accepted by the sign-up service.'],
  ] as const) {
    test(`says what ${code} means`, async ({ page }) => {
      await serveSignup(page, {
        status,
        json: {
          code,
          msg: code === 'weak_password' ? 'Password should be at least 6 characters.' : 'x',
        },
      });
      await page.goto('/signup.html');
      await fill(page);
      await page.getByLabel(/I accept the/).check();
      await page.getByRole('button', { name: 'Create account' }).click();
      if (field) {
        await expect(page.locator(field)).toHaveText(message);
      } else {
        await expect(page.locator('#status')).toHaveText(message);
      }
      await expect(page.locator('#status')).toHaveClass(/alert--error/);
      await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
    });
  }

  test('an unreachable sign-up service is reported, not hidden', async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.abort('connectionrefused'));
    await page.goto('/signup.html');
    await fill(page);
    await page.getByLabel(/I accept the/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#status')).toHaveText(
      'Could not reach the sign-up service. Check your connection and try again.',
    );
  });
});

test('terms that cannot be read keep sign-up closed', async ({ page }) => {
  await serveTerms(page, {
    status: 'pending',
    sections: [{ heading: 'Draft', paragraphs: ['x'] }],
  });
  await page.goto('/signup.html');
  await expect(page.locator('#status')).toHaveText(
    'The published terms of service are incomplete, so sign-up is closed.',
  );
  await expect(page.getByRole('button', { name: 'Create account' })).toBeDisabled();
});

test('someone already signed in is sent on to onboarding', async ({ page }) => {
  await signedIn(page);
  await page.route('https://e2e-api.invalid/**', (route) =>
    route.fulfill({ status: 403, json: { error: 'you are not a member of an organisation' } }),
  );
  await page.goto('/signup.html');
  await page.waitForURL('**/onboarding.html');
});

test('the login page links here, and here links back', async ({ page }) => {
  await page.goto('/login.html');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/signup\.html$/);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\.html$/);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await serveTerms(page);
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/signup.html');
  await expectNoSidewaysScroll(page);
});
