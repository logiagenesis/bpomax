// @ts-check
/**
 * The browser's client for the Arbitron API (ARB-062 onwards).
 *
 * The base URL is build-time configuration (`VITE_API_URL`, from API_URL in .env). The
 * bearer token comes from the session the login page stores (ARB-061, which needs B-06);
 * until then every request goes out unsigned and the API answers 401, which the page
 * shows as it is rather than hiding.
 */

export const SESSION_KEY = 'arbitron.session';

/** @returns {string} */
export function apiBaseUrl() {
  const configured = /** @type {string | undefined} */ (import.meta.env?.VITE_API_URL);
  return (configured || 'http://localhost:3000').replace(/\/+$/, '');
}

/** @returns {string | null} */
export function accessToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return typeof session?.access_token === 'string' ? session.access_token : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  /**
   * @param {number} status 0 when the server could not be reached
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * @param {string} path  e.g. "/v1/events"
 * @param {Record<string, string | number | undefined>} [query]
 * @returns {Promise<Response>}
 */
async function request(path, query = {}) {
  const url = new URL(`${apiBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const token = accessToken();
  /** @type {Record<string, string>} */
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new ApiError(0, 'Could not reach the API. Check that it is running and try again.');
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = typeof body?.error === 'string' ? body.error : '';
    } catch {
      /* not JSON */
    }
    if (response.status === 401) throw new ApiError(401, 'Not signed in. Sign in and try again.');
    throw new ApiError(
      response.status,
      detail
        ? `The API refused the request: ${detail}.`
        : `The API answered ${String(response.status)}.`,
    );
  }
  return response;
}

/**
 * @template T
 * @param {string} path
 * @param {Record<string, string | number | undefined>} [query]
 * @returns {Promise<T>}
 */
export async function apiGet(path, query = {}) {
  const response = await request(path, query);
  return /** @type {Promise<T>} */ (response.json());
}

/**
 * A file the API serves, with the headers that describe it.
 * @param {string} path
 * @param {Record<string, string | number | undefined>} [query]
 * @returns {Promise<{ blob: Blob, filename: string | null, headers: Headers }>}
 */
export async function apiGetFile(path, query = {}) {
  const response = await request(path, query);
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ?? null, headers: response.headers };
}
