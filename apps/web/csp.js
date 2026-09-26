// @ts-check
import { URL } from 'node:url';
/**
 * The web app's content security policy (ARB-501, the owner's audit S-03).
 *
 * Every page's script, style, font and image is served from the app's own origin (the
 * fonts are bundled, D-060), so the policy allows only that, plus the two places a page
 * calls: the Supabase project it signs in against and the API. Those two are known only at
 * build time (SUPABASE_URL and API_URL), so the policy is written into each page by the
 * build as a `<meta http-equiv>`; the headers that a meta tag cannot carry
 * (`frame-ancestors`, and the rest) come from vercel.json. A demo build calls nothing.
 *
 * @param {{ supabaseUrl?: string, apiUrl?: string }} hosts
 * @returns {string}
 */
export function contentSecurityPolicy(hosts) {
  /** @type {string[]} */
  const connect = ["'self'"];
  for (const url of [hosts.supabaseUrl, hosts.apiUrl]) {
    if (!url) continue;
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new Error(`not a URL for the content security policy: ${url}`);
    }
    if (!connect.includes(origin)) connect.push(origin);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Puts the policy first in `<head>`, so it governs everything after it.
 *
 * @param {string} html
 * @param {string} policy
 * @returns {string}
 */
export function withPolicy(html, policy) {
  if (!html.includes('<head>')) throw new Error('a page without <head> cannot carry its policy');
  return html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
  );
}
