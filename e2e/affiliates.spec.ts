import { expect, test, type Page } from '@playwright/test';
import {
  API,
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  me,
  serveApi,
  signedIn,
} from './helpers.js';

/**
 * ARB-430: the affiliates page, and a referral link's journey through the landing page
 * into the new organisation. The API is answered at the network edge in the shapes
 * `apps/api/src/routes/affiliates.ts` returns (tested against real Postgres in
 * affiliates.test.ts). The affiliate and its commission are test values (D-071).
 */
const PARTNER = {
  id: 'aaaaaaaa-0000-4000-8000-000000000040',
  code: 'partner-1',
  ownerEmail: 'partner@example.test',
  commissionPct: '12.500',
  active: true,
  createdAt: '2026-09-20T08:00:00Z',
  clicks: 5,
  signUps: 2,
  paid: 1,
  lastClickAt: '2026-09-23T10:15:00Z',
};

async function open(page: Page, affiliates = [PARTNER], refusal?: string) {
  await signedIn(page);
  const list = [...affiliates];
  const captured = await serveApi(page, {
    'GET /v1/affiliates': (_r, route) =>
      refusal
        ? route.fulfill({ status: 403, json: { error: refusal } })
        : route.fulfill({ json: { affiliates: list } }),
    'POST /v1/affiliates': (request, route) => {
      const body = request.body as { code: string };
      if (body.code === 'taken') {
        return route.fulfill({
          status: 409,
          json: { error: 'That code is already in use. Choose another.' },
        });
      }
      const affiliate = {
        ...PARTNER,
        id: crypto.randomUUID(),
        code: body.code,
        clicks: 0,
        signUps: 0,
        paid: 0,
        lastClickAt: null,
        commissionPct: null,
        ownerEmail: null,
      };
      list.push(affiliate);
      return route.fulfill({ status: 201, json: { affiliate } });
    },
    'PATCH /v1/affiliates/:id': (_r, route) => {
      list[0] = { ...list[0]!, active: !list[0]!.active };
      return route.fulfill({ json: { ok: true } });
    },
  });
  await page.goto('/affiliates.html');
  return captured;
}

test('lists each code with its link and its funnel, in the one format', async ({ page }) => {
  await open(page);
  await expectStatus(page, 'Showing 1 affiliate.');
  const cells = page.locator('tr[data-code="partner-1"] td');
  await expect(cells.nth(0)).toContainText('partner-1');
  await expect(cells.nth(0).locator('code')).toHaveText(/\/index\.html\?ref=partner-1$/);
  await expect(cells.nth(1)).toHaveText('partner@example.test');
  await expect(cells.nth(2)).toHaveText('12,5%');
  await expect(cells.nth(3)).toHaveText('5');
  await expect(cells.nth(4)).toHaveText('2');
  await expect(cells.nth(5)).toHaveText('1');
  await expect(cells.nth(6)).toHaveText('23/09/2026 12:15');
  await expectEveryLinkGoesSomewhere(page);
});

test('adds an affiliate, checking the form first', async ({ page }) => {
  const captured = await open(page, []);
  await expect(page.locator('#list-empty')).toBeVisible();
  await page.getByLabel('Referral code').fill('a b');
  await page.getByLabel('Commission (%, optional)').fill('150');
  await page.getByRole('button', { name: 'Add affiliate' }).click();
  await expect(page.locator('#code-error')).toContainText('3 to 40 letters');
  await expect(page.locator('#commissionPct-error')).toContainText('0 to 100');
  expect(captured.filter((c) => c.method === 'POST')).toHaveLength(0);

  await page.getByLabel('Referral code').fill('newsletter');
  await page.getByLabel('Commission (%, optional)').fill('');
  await page.getByRole('button', { name: 'Add affiliate' }).click();
  await expectStatus(page, 'Added newsletter. Its link is in the list below.');
  expect(captured.find((c) => c.method === 'POST')?.body).toEqual({
    code: 'newsletter',
    ownerEmail: '',
    commissionPct: '',
  });
  await expect(page.locator('tr[data-code="newsletter"] td').nth(2)).toHaveText('Not recorded');
});

test('a code in use is refused in the API s words', async ({ page }) => {
  await open(page, []);
  await page.getByLabel('Referral code').fill('taken');
  await page.getByRole('button', { name: 'Add affiliate' }).click();
  await expectStatus(page, 'That code is already in use. Choose another.');
});

test('a link can be switched off, and says what that means', async ({ page }) => {
  const captured = await open(page);
  await page.getByRole('button', { name: 'Switch off the link for partner-1' }).click();
  await expectStatus(page, 'The link for partner-1 is off: new clicks on it no longer count.');
  expect(captured.find((c) => c.method === 'PATCH')?.body).toEqual({ active: false });
});

test('anyone but the house org s owner is told whose programme it is', async ({ page }) => {
  await open(page, [], "Only the house organisation's owner runs the affiliate programme.");
  await expectStatus(page, "Only the house organisation's owner runs the affiliate programme.");
  await expect(page.locator('#new-affiliate')).toBeHidden();
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await open(page);
  await expect(page.locator('tr[data-code="partner-1"]')).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test.describe('a referral link, from the click to the new organisation', () => {
  test('the landing page records the click, keeps its id and takes the code out of the address', async ({
    page,
  }) => {
    const clicks: unknown[] = [];
    await page.route(`${API}/v1/referrals/clicks`, (route) => {
      clicks.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        json: { clickId: 'bbbbbbbb-0000-4000-8000-000000000001' },
      });
    });
    await page.goto('/index.html?ref=partner-1');
    await expect.poll(() => clicks.length).toBe(1);
    expect(clicks[0]).toEqual({ code: 'partner-1', landingPage: 'index.html' });
    await expect(page).toHaveURL(/\/index\.html$/);
    const kept = await page.evaluate(() => localStorage.getItem('arbitron.referral'));
    expect(JSON.parse(kept ?? '{}').clickId).toBe('bbbbbbbb-0000-4000-8000-000000000001');
  });

  test('a code that is not a code is dropped without a request', async ({ page }) => {
    let requests = 0;
    await page.route(`${API}/v1/referrals/clicks`, (route) => {
      requests += 1;
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('/index.html?ref=%3Cscript%3E');
    await expect(page).toHaveURL(/\/index\.html$/);
    expect(requests).toBe(0);
  });

  test('the organisation created afterwards carries the click, and the browser forgets it', async ({
    page,
  }) => {
    await signedIn(page);
    await page.addInitScript(() => {
      if (!localStorage.getItem('arbitron.referral.seeded')) {
        localStorage.setItem('arbitron.referral.seeded', '1');
        localStorage.setItem(
          'arbitron.referral',
          JSON.stringify({
            clickId: 'bbbbbbbb-0000-4000-8000-000000000001',
            at: '2026-09-24T08:00:00Z',
          }),
        );
      }
    });
    let member = false;
    const captured = await serveApi(page, {
      'GET /v1/onboarding': (_r, route) =>
        member
          ? route.fulfill({ json: { ...me(), steps: [] } })
          : route.fulfill({
              status: 403,
              json: { error: 'you are not a member of an organisation' },
            }),
      'POST /v1/orgs': (_r, route) => {
        member = true;
        return route.fulfill({ status: 201, json: me() });
      },
      'POST /v1/sessions': (_r, route) => route.fulfill({ status: 201, json: me() }),
    });
    // Terms as an owner might publish them (ARB-522); the wording is a placeholder.
    await page.route('**/terms.json', (route) =>
      route.fulfill({
        json: {
          status: 'approved',
          approvedBy: 'Approver name',
          approvedOn: '2026-10-01',
          version: 'v1',
          sections: [{ heading: 'Heading one', paragraphs: ['Paragraph one.'] }],
        },
      }),
    );
    await page.goto('/onboarding.html');
    await page.getByLabel('Organisation name').fill('Referred Co');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Create organisation' }).click();
    await expectStatus(page, 'Referred Co is created, and you are its owner.');
    expect(captured.find((c) => c.path === '/v1/orgs')?.body).toEqual({
      name: 'Referred Co',
      countryCode: 'ZA',
      termsVersion: 'v1',
      referral: 'bbbbbbbb-0000-4000-8000-000000000001',
    });
    expect(await page.evaluate(() => localStorage.getItem('arbitron.referral'))).toBeNull();
  });
});
