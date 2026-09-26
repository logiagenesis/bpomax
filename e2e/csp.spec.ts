import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * ARB-501, the owner's audit S-03: every built page carries the content security policy
 * (apps/web/csp.js), and no page breaks it. Each page is opened as it is served; a
 * `securitypolicyviolation` anywhere fails the test, so a script, style or call the
 * policy would block is found here rather than in a signed-in person's browser.
 */
const DIST = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const PAGES = readdirSync(DIST).filter((name) => name.endsWith('.html'));

test('the build has every page', () => {
  expect(PAGES).toContain('index.html');
  expect(PAGES.length).toBeGreaterThan(15);
});

for (const page of PAGES) {
  test(`${page} carries the policy and breaks none of it`, async ({ page: browser }) => {
    await browser.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await browser.goto(`/${page}`);
    await browser.waitForLoadState('networkidle').catch(() => undefined);
    const policy = await browser
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(await browser.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
      [],
    );
  });
}
