import type { FreelancerConfig } from './config.js';
import { parseBid, type FreelancerBid } from './employer.js';
import {
  FreelancerError,
  readJson,
  readRateLimit,
  send,
  type Fetch,
  type RateLimit,
} from './http.js';

/**
 * The freelancer's side of bidding (ARB-511, the owner's audit E-04, E-05). Both calls are
 * from the official documentation:
 *
 * - Create a bid: `POST /projects/0.1/bids/` "on behalf of a user who is not the project
 *   owner", with a JSON body whose required fields are `project_id`, `bidder_id` ("This is
 *   your user ID"), `amount` ("The currency is based on the projects currency"), `period`
 *   ("The amount of time (in days) it will take to complete the project") and
 *   `milestone_percentage` ("If the bid is awarded, an initial milestone is created for
 *   this percentage of the total project value"); `description` is optional. It answers
 *   `result.id` with the bid as stored
 *   (https://developers.freelancer.com/docs/use-cases/bidding-on-a-project, "Creating a
 *   Bid"). The reference lists its scopes as `basic` and `fln:project_manage`
 *   (https://developers.freelancer.com/docs/projects/bids, "Create a Bid"), which is
 *   advanced scope 2, already asked for at connect (oauth.ts).
 * - List bids: `GET /projects/0.1/bids/` filtered by `projects[]` and `bidders[]`
 *   ("Returns bids with the specified project IDs" / "bidder user IDs"; same reference,
 *   "List Bids"). Used to find a bid this account already placed on a project, so a bid
 *   placed just before a crash is found again rather than placed twice (E-05). The page
 *   does not print the list response; the envelope is read as the project-bids list is
 *   (`result.bids`), defensively, open under docs/BLOCKERS.md C-02 until the sandbox
 *   shows it.
 */
export interface BidRequest {
  readonly projectId: number;
  readonly bidderId: number;
  /** In the project's currency units, as the documented example sends them (60, not 6000). */
  readonly amount: number;
  /** Days to complete. */
  readonly period: number;
  readonly milestonePercentage: number;
  readonly description: string;
}

export interface PlacedBid {
  readonly id: string;
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Places the bid. Nothing here decides whether it may be placed: that is the submit worker's gate. */
export async function createBid(
  config: FreelancerConfig,
  accessToken: string,
  bid: BidRequest,
  deps: { readonly fetch?: Fetch } = {},
): Promise<PlacedBid> {
  const what = 'placing the bid';
  const response = await send(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/bids/`,
    {
      method: 'POST',
      headers: { 'freelancer-oauth-v1': accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: bid.projectId,
        bidder_id: bid.bidderId,
        amount: bid.amount,
        period: bid.period,
        milestone_percentage: bid.milestonePercentage,
        description: bid.description,
      }),
    },
    what,
  );
  const rateLimit = readRateLimit(response.headers);
  let body: Record<string, unknown>;
  try {
    body = await readJson(response, what);
  } catch (error) {
    if (error instanceof FreelancerError) error.rateLimit = rateLimit;
    throw error;
  }
  const id = record(body.result).id;
  if (typeof id !== 'number' && !(typeof id === 'string' && id.trim())) {
    throw new FreelancerError(
      'Freelancer.com answered the bid without an id',
      response.status,
      null,
      typeof body.request_id === 'string' ? body.request_id : null,
    );
  }
  return {
    id: String(id),
    requestId: typeof body.request_id === 'string' ? body.request_id : null,
    rateLimit,
  };
}

/** This bidder's bid on the project, if one exists: how a bid placed before a crash is found. */
export async function findBid(
  config: FreelancerConfig,
  accessToken: string,
  query: { readonly projectId: number; readonly bidderId: number },
  deps: { readonly fetch?: Fetch } = {},
): Promise<FreelancerBid | null> {
  const params = new URLSearchParams();
  params.append('projects[]', String(query.projectId));
  params.append('bidders[]', String(query.bidderId));
  const what = 'looking for an earlier bid';
  const response = await send(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/bids/?${params.toString()}`,
    { method: 'GET', headers: { 'freelancer-oauth-v1': accessToken } },
    what,
  );
  const rateLimit = readRateLimit(response.headers);
  let body: Record<string, unknown>;
  try {
    body = await readJson(response, what);
  } catch (error) {
    if (error instanceof FreelancerError) error.rateLimit = rateLimit;
    throw error;
  }
  const result = record(body.result);
  const list = Array.isArray(result.bids) ? result.bids : [];
  for (const raw of list) {
    const bid = parseBid(raw, record(result.users));
    if (bid && bid.bidderId === String(query.bidderId) && bid.projectId === String(query.projectId))
      return bid;
  }
  return null;
}
