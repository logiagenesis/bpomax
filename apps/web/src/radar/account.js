// @ts-check
/**
 * Dennis's Freelancer.com Personal Access Token (LI-PROMPT-BPOMAX-AUTOBID-20260928, F3,
 * constraint 2). It is kept only in this browser, under `radar.token`, which no backup
 * carries: Export leaves it out and Import never writes it. It is sent only to
 * Freelancer.com, in the `freelancer-oauth-v1` header. A token lasts 30 days from when it
 * was generated (F3); the page counts from when it was pasted and warns 5 days before.
 */
import { API, getResult, timeLimited } from './freelancer.js';

/** The storage key, without the `radar.` prefix. Not in store.js's backed-up keys. */
export const TOKEN_KEY = 'token';
const TOKEN_DAYS = 30;
const WARN_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} Account the token's owner, from GET /users/0.1/self/
 * @property {number} id
 * @property {string} username
 * @property {string | null} role
 * @property {boolean} limited
 * @property {string | null} membership the membership package's name
 * @property {number | null} bidLimit bids the membership allows per period
 * @property {string | null} bidPeriod the membership's duration type, such as `month`
 * @typedef {object} StoredToken
 * @property {string} token
 * @property {number} savedAt epoch milliseconds
 * @property {Account | null} account as last checked
 * @property {number | null} checkedAt epoch milliseconds
 * @property {string | null} problem why Freelancer.com last refused it; null when it did not
 * @typedef {'none' | 'ok' | 'soon' | 'expired'} TokenKind
 */

/** The account the token belongs to, with its membership (U4, verified 28/09/2026). */
export const SELF_URL = `${API}/users/0.1/self/?membership_details=true`;

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value ? value : null);

/**
 * @param {any} raw the `result` of GET /users/0.1/self/
 * @returns {Account}
 */
export function normaliseAccount(raw) {
  const pack = raw?.membership_package ?? {};
  return {
    id: Number(raw?.id),
    username: String(raw?.username ?? ''),
    role: text(raw?.role),
    limited: raw?.limited_account === true,
    membership: text(pack.name),
    bidLimit: num(pack.bid_limit),
    bidPeriod: text(pack.duration_type),
  };
}

/**
 * Asks Freelancer.com whose token this is. Throws a FreelancerError, with the HTTP status,
 * when it is refused, and a RequestTimeout when it does not answer within 15 seconds.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchSelf(token, fetchImpl = fetch) {
  const limited = timeLimited(fetchImpl);
  let account;
  try {
    account = normaliseAccount(await getResult(SELF_URL, limited.fetch, token));
  } catch (error) {
    throw limited.blame(error);
  } finally {
    limited.done();
  }
  if (!Number.isInteger(account.id) || account.id <= 0 || !account.username) {
    throw new Error('Freelancer.com answered, but without a user id and username.');
  }
  return account;
}

/**
 * What a pasted token looks like: no spaces inside, at least 20 characters. The paste
 * itself is trimmed first. Null when it will do, else what is wrong.
 * @param {string} token
 */
export function tokenProblem(token) {
  if (!token) return 'Paste the token first.';
  if (/\s/.test(token)) return 'A token has no spaces in it. Paste it again, on its own.';
  if (token.length < 20) return 'That is too short to be a token. Paste the whole of it.';
  return null;
}

/**
 * Where the token stands at `now`: absent, fine, due within 5 days, or past its 30.
 * @param {StoredToken | null} stored
 * @param {number} now
 * @returns {{ kind: TokenKind, expiresAt: number | null, daysLeft: number | null }}
 */
export function tokenState(stored, now) {
  if (!stored) return { kind: 'none', expiresAt: null, daysLeft: null };
  const expiresAt = stored.savedAt + TOKEN_DAYS * DAY_MS;
  const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
  const kind = now >= expiresAt ? 'expired' : daysLeft <= WARN_DAYS ? 'soon' : 'ok';
  return { kind, expiresAt, daysLeft: Math.max(daysLeft, 0) };
}

/**
 * The token as the page shows it: dots and its last four characters.
 * @param {string} token
 */
export function maskToken(token) {
  return `••••••••${token.slice(-4)}`;
}
