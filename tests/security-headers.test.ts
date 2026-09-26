import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, withPolicy } from '../apps/web/csp.js';

/**
 * ARB-501, the owner's audit S-03: the security headers Vercel sends with every page
 * (vercel.json, in the shape https://vercel.com/docs/project-configuration/vercel-json
 * documents: `headers[].source` and `key`/`value` pairs), and the content security
 * policy the build writes into each page (apps/web/csp.js). That no page breaks the
 * policy is e2e/csp.spec.ts.
 */
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};

describe('vercel.json', () => {
  it('sends the security headers with every path', () => {
    const all = vercel.headers?.find((rule) => rule.source === '/(.*)');
    const headers = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(headers).toEqual({
      'Content-Security-Policy':
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
  });
});

describe('the page policy', () => {
  it('allows only the app itself, and calls to the Supabase project and the API', () => {
    expect(
      contentSecurityPolicy({
        supabaseUrl: 'https://abc.supabase.co',
        apiUrl: 'https://api.example.test/v1/',
      }),
    ).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://abc.supabase.co https://api.example.test; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  it('calls nothing outside the app in a demo build, and refuses a host that is not a URL', () => {
    expect(contentSecurityPolicy({})).toContain("connect-src 'self';");
    expect(() => contentSecurityPolicy({ apiUrl: 'not a url' })).toThrow(/not a URL/);
  });

  it('is the first thing in a page head', () => {
    const html = withPolicy('<!doctype html><html><head><title>x</title></head></html>', 'P');
    expect(html).toMatch(
      /^<!doctype html><html><head>\n {4}<meta http-equiv="Content-Security-Policy" content="P" \/>\n?<title>/,
    );
    expect(() => withPolicy('<html></html>', 'P')).toThrow(/without <head>/);
  });
});
