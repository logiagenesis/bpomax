// @ts-check
/**
 * The browser's session (ARB-061). What the login page stores after Supabase Auth
 * answers, and what every other page reads its bearer token from.
 *
 * It lives in sessionStorage: gone when the tab closes, never sent as a cookie (D-027),
 * and never written anywhere a later page load could pick up by accident.
 */
export const SESSION_KEY = 'arbitron.session';

/**
 * @typedef {object} Session
 * @property {string} access_token
 * @property {string} [refresh_token]
 * @property {number} [expires_at] seconds since the epoch
 * @property {{ id: string, email?: string }} [user]
 */

/** @returns {Session | null} */
export function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return typeof session?.access_token === 'string' ? session : null;
  } catch {
    return null;
  }
}

/** @param {Session} session */
export function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

/**
 * The Supabase project the login page talks to: SUPABASE_URL and SUPABASE_ANON_KEY from
 * .env, put into the build by apps/web/vite.config.js. Both are public browser values.
 */
export function authConfig() {
  const env = /** @type {Record<string, string | undefined>} */ (import.meta.env ?? {});
  const url = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? '';
  return url && anonKey ? { url, anonKey } : null;
}

/** The page name of the current document, e.g. "feed.html". */
export function currentPage() {
  const name = location.pathname.split('/').pop() || 'index.html';
  return name.endsWith('.html') ? name : 'index.html';
}

/** Where to go after sign-in: only a page of this app, never a URL from outside. */
export function loginUrl(next = currentPage()) {
  return `./login.html?next=${encodeURIComponent(next)}`;
}

/**
 * Reads the session or sends the browser to the login page. Returns null after
 * redirecting so a caller can stop its work.
 * @returns {Session | null}
 */
export function requireSession() {
  const session = readSession();
  if (session) return session;
  location.replace(loginUrl());
  return null;
}

/**
 * Ends the session. Supabase is told first so the refresh token is revoked
 * (`POST /auth/v1/logout`, the request `supabase.auth.signOut()` makes:
 * https://supabase.com/docs/reference/javascript/auth-signout); the local copy goes
 * whether or not that call succeeds, because the person asked to leave.
 * @param {typeof fetch} [doFetch]
 */
export async function signOut(doFetch = fetch) {
  const session = readSession();
  const config = authConfig();
  if (session && config) {
    try {
      await doFetch(`${config.url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: config.anonKey, authorization: `Bearer ${session.access_token}` },
      });
    } catch {
      /* the session is cleared regardless */
    }
  }
  clearSession();
}
