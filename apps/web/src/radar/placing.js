// @ts-check
/**
 * Placing a bid on Freelancer.com from this page (LI-PROMPT-BPOMAX-AUTOBID-20260928, F2,
 * F3b, step 3). The two calls are the ARB-511 bid placer's own (`createBid` and
 * `findBid`, packages/freelancer/src/bidding.ts); the placer around them needs the
 * server's database, which this page does not have, so the page makes the same two calls
 * with Dennis's token. Before sending, it asks Freelancer.com for a bid of his on the
 * project, and sends nothing if there is one (constraint 4: never twice).
 */
import { createBid, findBid } from '@arbitron/freelancer/bidding';
import { FREELANCER } from './links.js';
import { findPlaceholders, placeholderProblem } from './proposal.js';

/**
 * @typedef {Parameters<typeof createBid>[0]} FreelancerConfig
 * @typedef {object} BidToPlace
 * @property {number} projectId
 * @property {number} bidderId Dennis's user id, from the token check
 * @property {number} price in the project's currency
 * @property {number} days
 * @property {string} description the proposal
 * @typedef {object} Placed
 * @property {'placed' | 'already'} outcome `already`: Freelancer.com already had his bid
 * @property {string} bidId Freelancer.com's id for the bid
 * @property {number | null} status the HTTP status of the last answer
 */

/**
 * Only the API address is used by the two calls; the rest belongs to the OAuth app the
 * server would use, which a Personal Access Token does not need (F3).
 * @type {FreelancerConfig}
 */
const CONFIG = {
  environment: 'production',
  baseUrl: FREELANCER,
  apiUrl: `${FREELANCER}/api`,
  accountsUrl: 'https://accounts.freelancer.com',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
};

/**
 * A bid without milestones asks for 100 % as its first milestone, as the ARB-511 placer
 * sends it (D-077).
 */
const MILESTONE_PERCENTAGE = 100;

/**
 * Places the bid unless Freelancer.com already has one of his on the project. Throws the
 * package's FreelancerError (with `status`, 0 when nothing came back) when refused. Throws
 * a plain Error, before any call, when the proposal still has text in curly braces: the
 * page checks that first, and this is the last stop behind it.
 * @param {string} token
 * @param {BidToPlace} bid
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Placed>}
 */
export async function placeBid(token, bid, fetchImpl = fetch) {
  const blocked = placeholderProblem(findPlaceholders(bid.description));
  if (blocked) throw new Error(blocked);
  /** @type {number | null} */
  let status = null;
  /** @type {typeof fetch} */
  const watched = async (input, init) => {
    const response = await fetchImpl(input, init);
    status = response.status;
    return response;
  };
  const deps = { fetch: /** @type {any} */ (watched) };
  const earlier = await findBid(
    CONFIG,
    token,
    { projectId: bid.projectId, bidderId: bid.bidderId },
    deps,
  );
  if (earlier) return { outcome: 'already', bidId: earlier.id, status };
  const placed = await createBid(
    CONFIG,
    token,
    {
      projectId: bid.projectId,
      bidderId: bid.bidderId,
      amount: bid.price,
      period: bid.days,
      milestonePercentage: MILESTONE_PERCENTAGE,
      description: bid.description,
    },
    deps,
  );
  return { outcome: 'placed', bidId: placed.id, status };
}

/**
 * The HTTP status an error carries: the package's FreelancerError and the page's both
 * have one. Null when there is none.
 * @param {unknown} error
 * @returns {number | null}
 */
export function statusOf(error) {
  const status = /** @type {{ status?: unknown }} */ (error)?.status;
  return typeof status === 'number' ? status : null;
}
