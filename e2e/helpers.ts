import { expect, type Page, type Route } from '@playwright/test';

/**
 * Shared scaffolding for the ARB-061 page specs. The build under test is the e2e one
 * (`apps/web/.env.e2e`): its API and Supabase URLs are stand-ins that resolve nowhere,
 * and every request to them is answered here, at the network edge, with the shapes the
 * real routes return (proven against Postgres in apps/api/src/routes/pages.test.ts).
 */
export const API = 'https://e2e-api.invalid';
export const SUPABASE = 'https://e2e.supabase.invalid';
export const ANON_KEY = 'e2e-anon-key';

export const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
export const USER = 'aaaaaaaa-0000-4000-8000-000000000002';

export type Role = 'owner' | 'operator' | 'viewer';

export function me(role: Role = 'owner') {
  return {
    user: {
      id: USER,
      email: 'ayanda@example.com',
      fullName: 'Ayanda Nkosi',
      telegramLinked: false,
    },
    org: { id: ORG, name: 'Logi-Ink', baseCurrency: 'ZAR' },
    role,
  };
}

export const SESSION = {
  access_token: 'e2e-access-token',
  refresh_token: 'e2e-refresh-token',
  expires_at: 4102444800,
  user: { id: USER, email: 'ayanda@example.com' },
};

/** Puts a session in the tab before any page script runs. */
export async function signedIn(page: Page): Promise<void> {
  // Seeded once per tab: the init script runs on every navigation, and a test that
  // signs out or is signed out must find the session gone on the next page.
  await page.addInitScript((session) => {
    if (sessionStorage.getItem('e2e.seeded')) return;
    sessionStorage.setItem('e2e.seeded', '1');
    sessionStorage.setItem('arbitron.session', JSON.stringify(session));
  }, SESSION);
}

export interface Captured {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string | null;
}

export type Handler = (request: Captured, route: Route) => Promise<void> | void;

/**
 * Serves the API. `handlers` are tried in order on `${METHOD} ${pathname}`; a request
 * nobody claims gets 404 so a page that calls something unexpected fails loudly. Every
 * request is captured, with its bearer token, for assertions.
 */
export async function serveApi(
  page: Page,
  handlers: Record<string, Handler>,
  options: { role?: Role } = {},
): Promise<Captured[]> {
  const captured: Captured[] = [];
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const auth = request.headers()['authorization'] ?? null;
    let body: unknown = null;
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const entry: Captured = {
      method: request.method(),
      path: url.pathname,
      query: url.searchParams,
      body,
      auth,
    };
    captured.push(entry);

    if (entry.path === '/v1/me' && !handlers['GET /v1/me']) {
      await route.fulfill({ json: me(options.role) });
      return;
    }
    for (const [key, handler] of Object.entries(handlers)) {
      const [method, pattern] = key.split(' ', 2);
      const regex = new RegExp(`^${pattern!.replace(/:\w+/g, '[^/]+')}$`);
      if (method === entry.method && regex.test(entry.path)) {
        await handler(entry, route);
        return;
      }
    }
    await route.fulfill({
      status: 404,
      json: { error: `no e2e handler for ${entry.method} ${entry.path}` },
    });
  });
  return captured;
}

export async function expectStatus(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('#status')).toHaveText(text);
}

/** The audit rule: at phone width nothing scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Every link on the page has a real destination: no "#" and no empty href (05 section 1.2). */
export async function expectEveryLinkGoesSomewhere(page: Page): Promise<void> {
  const hrefs = await page
    .locator('a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect(href).toMatch(/^\.\/[a-z-]+\.html(\?[^#]*)?(#[a-z-]+)?$/);
}
