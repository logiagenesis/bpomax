import { expect, test, type Page } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Role,
} from './helpers.js';

/**
 * ARB-420: the billing page. The API is answered at the network edge in the shape
 * `GET /v1/billing` and `POST /v1/billing/checkout` return
 * (apps/api/src/routes/billing.test.ts). The plan, its limits and prices are test values;
 * no real plan exists (docs/02 D-12).
 */
const PLAN = {
  code: 'test-plan',
  name: 'Test plan',
  limits: { jobs_scored: 100, bids_drafted: 50, bids_submitted: null },
  prices: [
    { currency: 'ZAR', provider: 'paystack', amountMinor: 49_900 },
    { currency: 'USD', provider: 'stripe', amountMinor: 2_900 },
  ],
};
const CONFIGURED = { configured: true, environment: 'stand-in', reason: null };

function billing(overrides: Record<string, unknown> = {}) {
  return {
    role: 'owner',
    houseOrg: false,
    state: {
      kind: 'none',
      reason: 'no_subscription',
      message: 'This organisation has no plan yet. Choose a plan in Settings to continue.',
    },
    subscription: null,
    plans: [PLAN],
    graceDays: 7,
    providers: { paystack: CONFIGURED, stripe: CONFIGURED },
    ...overrides,
  };
}

async function open(
  page: Page,
  body: Record<string, unknown> = billing(),
  options: { role?: Role; checkout?: { status: number; json: unknown }; query?: string } = {},
) {
  await signedIn(page);
  const captured = await serveApi(
    page,
    {
      'GET /v1/billing': (_r, route) => route.fulfill({ json: body }),
      'POST /v1/billing/checkout': (_r, route) =>
        route.fulfill(
          options.checkout ?? {
            status: 201,
            json: {
              url: './billing.html?checkout=arb-test',
              provider: 'paystack',
              reference: 'arb-test',
            },
          },
        ),
    },
    { role: options.role ?? 'owner' },
  );
  await page.goto(`/billing.html${options.query ?? ''}`);
  return captured;
}

test('lists each plan with its monthly limits and a Pay button per currency and provider', async ({
  page,
}) => {
  await open(page);
  await expectStatus(page, 'Billing loaded.');
  await expect(page.locator('#billing-state')).toHaveText(
    'This organisation has no plan yet. Choose a plan in Settings to continue.',
  );
  const card = page.locator('[data-plan="test-plan"]');
  await expect(card.locator('h3')).toHaveText('Test plan');
  await expect(card.locator('li')).toHaveText([
    'Jobs scored: 100 a month',
    'Bids drafted: 50 a month',
    'Bids sent: no limit',
  ]);
  await expect(card.getByRole('button')).toHaveText([
    'Pay R499,00 with Paystack',
    'Pay USD 29,00 with Stripe',
  ]);
  await expectEveryLinkGoesSomewhere(page);
});

test('Pay asks for the checkout in that currency and goes to the provider s page', async ({
  page,
}) => {
  const captured = await open(page);
  await page.getByRole('button', { name: 'Pay R499,00 with Paystack' }).click();
  await page.waitForURL('**/billing.html');
  const request = captured.find((c) => c.path === '/v1/billing/checkout');
  expect(request?.method).toBe('POST');
  expect(request?.body).toEqual({ plan: 'test-plan', currency: 'ZAR' });
});

test('back from the provider, the page says the webhook decides, and clears the address', async ({
  page,
}) => {
  await open(page, billing(), { query: '?checkout=arb-test' });
  await expectStatus(
    page,
    'Thank you. The plan starts as soon as the payment provider confirms the payment; reload this page to see it.',
  );
  await expect(page).toHaveURL(/\/billing\.html$/);
});

test('a cancelled checkout says nothing was charged', async ({ page }) => {
  await open(page, billing(), { query: '?checkout=cancelled' });
  await expectStatus(page, 'The checkout was cancelled. Nothing was charged.');
});

test('a provider refusal is shown as it is', async ({ page }) => {
  await open(page, billing(), {
    checkout: {
      status: 502,
      json: {
        error: 'Stripe refused to start a checkout (HTTP 400: No such price). Nothing was charged.',
      },
    },
  });
  await page.getByRole('button', { name: 'Pay USD 29,00 with Stripe' }).click();
  await expectStatus(
    page,
    'Stripe refused to start a checkout (HTTP 400: No such price). Nothing was charged.',
  );
  await expect(page.locator('#status')).toHaveClass(/alert--error/);
});

test('a plan with a failed payment shows when the grace period ends', async ({ page }) => {
  await open(
    page,
    billing({
      state: { kind: 'plan', plan: { name: 'Test plan' }, status: 'past_due' },
      subscription: {
        plan: 'test-plan',
        status: 'past_due',
        provider: 'stripe',
        currency: 'USD',
        graceUntil: '2026-10-01T08:00:00.000Z',
      },
    }),
  );
  await expect(page.locator('#billing-state')).toHaveText(
    'Plan: Test plan, a payment has failed, paid through Stripe.',
  );
  await expect(page.locator('#billing-grace')).toHaveText(
    'The plan keeps working until 01/10/2026. Pay what is owed with Stripe before then to keep it.',
  );
  // One plan at a time: no second checkout while this one runs (D-070).
  for (const button of await page.locator('[data-plan] button').all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'This organisation already has a plan.');
  }
});

test('an operator sees the plans with every Pay button off, saying why', async ({ page }) => {
  await open(page, billing({ role: 'operator' }), { role: 'operator' });
  const button = page.getByRole('button', { name: 'Pay R499,00 with Paystack' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'Only an owner can choose or pay for the plan.');
});

test('a provider without its keys has its button off with the reason (B-15)', async ({ page }) => {
  await open(
    page,
    billing({
      providers: {
        paystack: CONFIGURED,
        stripe: {
          configured: false,
          environment: null,
          reason: 'Stripe is not configured: STRIPE_SECRET_KEY is not set (docs/02 B-15).',
        },
      },
    }),
  );
  await expect(page.getByRole('button', { name: 'Pay USD 29,00 with Stripe' })).toHaveAttribute(
    'title',
    'Stripe is not configured: STRIPE_SECRET_KEY is not set (docs/02 B-15).',
  );
  await expect(page.getByRole('button', { name: 'Pay R499,00 with Paystack' })).toBeEnabled();
});

test('the house org is told it is not billed; with no plans published, the page says why', async ({
  page,
}) => {
  await open(page, billing({ houseOrg: true, state: { kind: 'exempt' }, plans: [] }));
  await expect(page.locator('#billing-state')).toHaveText(
    'This is the house organisation: it is not billed, and every metered action is counted without a limit.',
  );
  await expect(page.locator('#plans-empty')).toBeVisible();
  await expect(page.locator('#plans-empty')).toContainText('D-12');
});

test('Settings links here', async ({ page }) => {
  await open(page);
  await page.getByRole('link', { name: 'Back to Settings' }).click();
  await expect(page).toHaveURL(/\/settings\.html$/);
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expectNoSidewaysScroll(page);
});
