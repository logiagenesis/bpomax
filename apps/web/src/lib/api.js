// @ts-check
/**
 * The web pages' one way to call the API (ARB-062 onwards).
 *
 * The API base URL comes from `<meta name="arbitron-api">` on the page, and is the
 * page's own origin when that is empty, so deployment (ARB-070) can point it anywhere
 * without a rebuild. The access token is the Supabase session's. Signing in is ARB-061
 * and needs the Supabase project (B-06), so until then no page has a token and every
 * call answers "signed out". That is the correct answer, not a bug.
 *
 * Every failure becomes an `ApiError` whose message says what happened and what to do
 * next (docs/05 section 2, rule 4). Pages show the message as it is.
 */
export const TOKEN_KEY = 'arbitron.accessToken';

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status 0 when the server could not be reached
   */
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiBase() {
  const meta = document.querySelector('meta[name="arbitron-api"]');
  const configured = meta?.getAttribute('content')?.trim();
  return configured ? configured.replace(/\/$/, '') : window.location.origin;
}

function accessToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * @param {string} path e.g. `/v1/events`
 * @param {Record<string, string | undefined>} [params] empty values are left out
 */
export function apiUrl(path, params = {}) {
  const url = new URL(`${apiBase()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return url;
}

/**
 * @param {string} path
 * @param {Record<string, string | undefined>} [params]
 * @returns {Promise<Response>} a response with a 2xx status
 */
export async function apiGet(path, params = {}) {
  const token = accessToken();
  let response;
  try {
    response = await fetch(apiUrl(path, params), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  if (response.ok) return response;

  if (response.status === 401) {
    throw new ApiError('You are signed out. Sign in again, then reload this page.', 401);
  }
  let detail = '';
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    // Not JSON; the status alone has to do.
  }
  if (response.status === 400 && detail) {
    throw new ApiError(`The server did not accept the filters: ${detail}.`, 400);
  }
  throw new ApiError(
    `The server could not answer (HTTP ${response.status}). Try again in a minute.`,
    response.status,
  );
}

/**
 * @template T
 * @param {string} path
 * @param {Record<string, string | undefined>} [params]
 * @returns {Promise<T>}
 */
export async function apiGetJson(path, params = {}) {
  const response = await apiGet(path, params);
  return /** @type {T} */ (await response.json());
}
