// @ts-check
/**
 * The developer finder (LI-PROMPT-BPOMAX-RADAR-20260927, 4.6): Freelancer.com's public
 * freelancer directory (F6), read from the browser. The fields are the ones the directory
 * gives, checked live on 27/09/2026: `hourly_rate` (in USD — a profile shows the same figure
 * as "$55 USD / Hour" whatever the freelancer's own currency), and under
 * `reputation.entire_history`: `all` (jobs), `complete`, `reviews`, `overall` (rating out
 * of 5) and `completion_rate` (0 to 1). There is no field named "jobs" in the history; the
 * count of all jobs is `all`.
 */
import { API, getResult } from './freelancer.js';
import { FREELANCER } from './links.js';

/**
 * @typedef {object} Developer
 * @property {number} id
 * @property {string} username
 * @property {string} profile the profile page on Freelancer.com
 * @property {string | null} country
 * @property {number | null} hourlyRateUsd
 * @property {number} jobs all jobs (`entire_history.all`)
 * @property {number} completed
 * @property {number} reviews
 * @property {number | null} rating out of 5
 * @property {number | null} completionRate 0 to 1
 * @typedef {object} Shortlisted
 * @property {string} username
 * @property {string} profile
 * @property {string | null} country
 * @property {number | null} hourlyRateUsd as the directory gave it when shortlisted
 * @property {number | null} rating
 * @property {number} reviews
 * @property {number | null} rateUsd the owner's own figure: the price or rate agreed or expected
 * @property {string} note
 */

/** @param {string} query */
export function directoryUrl(query) {
  const params = new URLSearchParams({
    query,
    limit: '50',
    reputation: 'true',
    country_details: 'true',
  });
  return `${API}/users/0.1/users/directory/?${params.toString()}`;
}

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * @param {any} raw one user from the directory
 * @returns {Developer}
 */
export function normaliseDeveloper(raw) {
  const history = raw.reputation?.entire_history ?? {};
  const username = String(raw.username ?? '');
  return {
    id: Number(raw.id),
    username,
    profile: `${FREELANCER}/u/${encodeURIComponent(username)}`,
    country: typeof raw.location?.country?.name === 'string' ? raw.location.country.name : null,
    hourlyRateUsd: num(raw.hourly_rate),
    jobs: num(history.all) ?? 0,
    completed: num(history.complete) ?? 0,
    reviews: num(history.reviews) ?? 0,
    rating: num(history.overall),
    completionRate: num(history.completion_rate),
  };
}

/**
 * Up to 50 freelancers matching the search.
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Developer[]>}
 */
export async function fetchDevelopers(query, fetchImpl = fetch) {
  const result = await getResult(directoryUrl(query), fetchImpl);
  return (Array.isArray(result?.users) ? result.users : []).map(normaliseDeveloper);
}

/**
 * The owner's filters (completion at least `minCompletion` %, at least `minReviews`
 * reviews), best rated first, then most reviewed.
 * @param {Developer[]} list
 * @param {{ devMinCompletion: number, devMinReviews: number }} settings
 */
export function pickDevelopers(list, settings) {
  return list
    .filter(
      (d) =>
        (d.completionRate ?? 0) * 100 >= settings.devMinCompletion &&
        d.reviews >= settings.devMinReviews,
    )
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews);
}

/**
 * A developer as the shortlist keeps them, with the owner's rate starting at theirs.
 * @param {Developer} developer
 * @returns {Shortlisted}
 */
export function toShortlist(developer) {
  return {
    username: developer.username,
    profile: developer.profile,
    country: developer.country,
    hourlyRateUsd: developer.hourlyRateUsd,
    rating: developer.rating,
    reviews: developer.reviews,
    rateUsd: developer.hourlyRateUsd,
    note: '',
  };
}
