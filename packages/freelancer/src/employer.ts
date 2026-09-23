import type { FreelancerConfig } from './config.js';
import {
  FreelancerError,
  readJson,
  readRateLimit,
  send,
  type Fetch,
  type RateLimit,
} from './http.js';

/**
 * The employer's side of Freelancer.com (ARB-203): posting a sourcing project and reading
 * the bids suppliers place on it. Every call is from the official documentation:
 *
 * - Currencies: `GET /projects/0.1/currencies/?currency_codes[]=AUD` answers
 *   `result.currencies[]` with `id` and `code`
 *   (https://developers.freelancer.com/docs/use-cases/creating-a-project, "Currency ID").
 * - Skills: `GET /projects/0.1/jobs/search/?job_names[]=PHP` answers `result[]` with `id`
 *   and `name` (same page, "Finding Job IDs").
 * - Create a project: `POST /projects/0.1/projects/` with a JSON body `{ title,
 *   description, currency: { id }, budget: { minimum, maximum }, jobs: [{ id }] }`,
 *   needing the `fln:project_create` scope; it answers `result.id`, `result.seo_url` and
 *   the title as created, which may carry a number when the title is taken (same page,
 *   "Fixed Project"; https://developers.freelancer.com/docs/projects/projects, "Create a
 *   Project").
 * - List project bids: `GET /projects/0.1/projects/{project_id}/bids/` with the
 *   `user_details` and `user_country_details` projections
 *   (https://developers.freelancer.com/docs/projects/projects, "List Project Bids"). The
 *   bid's own fields are the ones the create page's `hireme_initial_bid` example shows:
 *   `id`, `bidder_id`, `project_id`, `amount`, `period`, `submitdate`. The page does not
 *   print a list response, so the envelope (`result.bids`, `result.users`) and where a
 *   bidder's country sits (`location.country.code`, as on a project) are read
 *   defensively and are open under docs/BLOCKERS.md C-02 until the sandbox shows them.
 */
export interface CreatedProject {
  readonly id: string;
  readonly seoUrl: string | null;
  readonly title: string | null;
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

export interface ProjectDraft {
  readonly title: string;
  readonly description: string;
  readonly currencyId: number;
  /** In the currency's units, as the documented example sends them (250, not 25000). */
  readonly budget: { readonly minimum: number; readonly maximum: number };
  readonly jobIds: readonly number[];
}

export interface FreelancerBid {
  readonly id: string;
  readonly bidderId: string;
  readonly projectId: string | null;
  /** In the project's currency units, as the API sends it. */
  readonly amount: number;
  /** Days to deliver. */
  readonly period: number | null;
  readonly submittedAt: Date | null;
  readonly description: string | null;
  readonly bidderUsername: string | null;
  readonly bidderCountryCode: string | null;
}

export interface BidPage {
  readonly bids: readonly FreelancerBid[];
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const idText = (value: unknown): string | null =>
  typeof value === 'number' || (typeof value === 'string' && value.trim()) ? String(value) : null;

async function getJson(
  fetchImpl: Fetch,
  url: string,
  accessToken: string,
  what: string,
): Promise<{ body: Record<string, unknown>; rateLimit: RateLimit; status: number }> {
  const response = await send(
    fetchImpl,
    url,
    { method: 'GET', headers: { 'freelancer-oauth-v1': accessToken } },
    what,
  );
  const rateLimit = readRateLimit(response.headers);
  try {
    return { body: await readJson(response, what), rateLimit, status: response.status };
  } catch (error) {
    if (error instanceof FreelancerError) error.rateLimit = rateLimit;
    throw error;
  }
}

/** The platform's id for an ISO currency code, or null when it does not list the code. */
export async function findCurrencyId(
  config: FreelancerConfig,
  accessToken: string,
  code: string,
  deps: { readonly fetch?: Fetch } = {},
): Promise<number | null> {
  const params = new URLSearchParams();
  params.append('currency_codes[]', code.toUpperCase());
  const { body } = await getJson(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/currencies/?${params.toString()}`,
    accessToken,
    'the currency lookup',
  );
  const currencies = record(body.result).currencies;
  if (!Array.isArray(currencies)) return null;
  for (const item of currencies) {
    const c = record(item);
    if (str(c.code)?.toUpperCase() === code.toUpperCase()) return num(c.id);
  }
  return null;
}

/** The platform's skills (jobs) whose name is exactly one of `names`, ignoring case. */
export async function findJobIds(
  config: FreelancerConfig,
  accessToken: string,
  names: readonly string[],
  deps: { readonly fetch?: Fetch } = {},
): Promise<number[]> {
  const params = new URLSearchParams();
  for (const name of names) params.append('job_names[]', name);
  const { body } = await getJson(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/jobs/search/?${params.toString()}`,
    accessToken,
    'the skill lookup',
  );
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
  const found: number[] = [];
  const list = Array.isArray(body.result) ? body.result : [];
  for (const item of list) {
    const job = record(item);
    const id = num(job.id);
    const name = str(job.name)?.toLowerCase();
    if (id !== null && name && wanted.has(name) && !found.includes(id)) found.push(id);
  }
  return found;
}

/** Posts the project. Nothing here decides whether it may be posted: that is the caller's gate. */
export async function createProject(
  config: FreelancerConfig,
  accessToken: string,
  draft: ProjectDraft,
  deps: { readonly fetch?: Fetch } = {},
): Promise<CreatedProject> {
  const what = 'creating the project';
  const response = await send(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/projects/`,
    {
      method: 'POST',
      headers: { 'freelancer-oauth-v1': accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        description: draft.description,
        currency: { id: draft.currencyId },
        budget: { minimum: draft.budget.minimum, maximum: draft.budget.maximum },
        jobs: draft.jobIds.map((id) => ({ id })),
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
  const result = record(body.result);
  const id = idText(result.id);
  if (id === null) {
    throw new FreelancerError(
      'Freelancer.com answered the new project without an id',
      response.status,
      null,
      str(body.request_id),
    );
  }
  return {
    id,
    seoUrl: str(result.seo_url),
    title: str(result.title),
    requestId: str(body.request_id),
    rateLimit,
  };
}

export function parseBid(raw: unknown, users: Record<string, unknown>): FreelancerBid | null {
  const bid = record(raw);
  const id = idText(bid.id);
  const bidderId = idText(bid.bidder_id);
  const amount = num(bid.amount);
  if (id === null || bidderId === null || amount === null) return null;
  const user = record(users[bidderId]);
  const country = record(record(user.location).country);
  const code = str(country.code);
  const submitted = num(bid.submitdate) ?? num(bid.time_submitted);
  return {
    id,
    bidderId,
    projectId: idText(bid.project_id),
    amount,
    period: num(bid.period),
    submittedAt: submitted === null ? null : new Date(submitted * 1000),
    description: str(bid.description),
    bidderUsername: str(user.username),
    bidderCountryCode: code && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null,
  };
}

/** Every bid on the project, a page at a time. */
export async function listProjectBids(
  config: FreelancerConfig,
  accessToken: string,
  projectId: string,
  query: { readonly limit?: number; readonly offset?: number } = {},
  deps: { readonly fetch?: Fetch } = {},
): Promise<BidPage> {
  const params = new URLSearchParams();
  params.set('user_details', 'true');
  params.set('user_country_details', 'true');
  params.set('limit', String(Math.min(query.limit ?? 100, 100)));
  params.set('offset', String(query.offset ?? 0));
  const { body, rateLimit } = await getJson(
    deps.fetch ?? fetch,
    `${config.apiUrl}/projects/0.1/projects/${encodeURIComponent(projectId)}/bids/?${params.toString()}`,
    accessToken,
    'the project’s bids',
  );
  const result = record(body.result);
  const users = record(result.users);
  const list = Array.isArray(result.bids) ? result.bids : [];
  return {
    bids: list.map((raw) => parseBid(raw, users)).filter((b): b is FreelancerBid => b !== null),
    requestId: str(body.request_id),
    rateLimit,
  };
}
