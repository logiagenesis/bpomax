// @ts-check
/**
 * The browser's client for the Arbitron API (ARB-062 onwards).
 *
 * The base URL is build-time configuration (API_URL in .env, put into the build by
 * apps/web/vite.config.js). The
 * bearer token comes from the session the login page stores (ARB-061). Without one every
 * request goes out unsigned and the API answers 401, which the page shows as it is rather
 * than hiding.
 */
import { readSession } from './session.js';

export { SESSION_KEY } from './session.js';

/** @returns {string} */
export function apiBaseUrl() {
  const configured = /** @type {string | undefined} */ (import.meta.env?.VITE_API_URL);
  return (configured || 'http://localhost:3000').replace(/\/+$/, '');
}

/** @returns {string | null} */
export function accessToken() {
  return readSession()?.access_token ?? null;
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
    /** Field-level problems from a 422, in the same shape the validators produce. */
    /** @type {{ field: string, message: string }[]} */
    this.errors = [];
  }
}

/**
 * @param {string} path  e.g. "/v1/events"
 * @param {Record<string, string | number | undefined>} [query]
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<Response>}
 */
async function request(path, query = {}, options = {}) {
  const url = new URL(`${apiBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const token = accessToken();
  /** @type {Record<string, string>} */
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the API. Check that it is running and try again.');
  }

  if (!response.ok) {
    let detail = '';
    /** @type {{ field: string, message: string }[]} */
    let errors = [];
    try {
      const body = await response.json();
      detail = typeof body?.error === 'string' ? body.error : '';
      if (Array.isArray(body?.errors)) errors = body.errors;
    } catch {
      /* not JSON */
    }
    if (response.status === 401) throw new ApiError(401, 'Not signed in. Sign in and try again.');
    const error = new ApiError(
      response.status,
      errors.length > 0
        ? 'Some fields need attention. The first one has been selected.'
        : detail
          ? /[.!?]$/.test(detail)
            ? detail
            : `The API refused the request: ${detail}.`
          : `The API answered ${String(response.status)}.`,
    );
    error.errors = errors;
    throw error;
  }
  return response;
}

/**
 * Sends JSON and reads JSON back. A 204 reads as `undefined`.
 * @template T
 * @param {'POST' | 'PUT' | 'PATCH' | 'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<T>}
 */
export async function apiSend(method, path, body) {
  const response = await request(path, {}, { method, body });
  if (response.status === 204) return /** @type {T} */ (undefined);
  return /** @type {Promise<T>} */ (response.json());
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
