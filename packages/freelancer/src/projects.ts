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
 * `GET /projects/0.1/projects/active/` — "Searches for active projects matching the
 * desired query" (https://developers.freelancer.com/docs/projects/projects, "Search for
 * Active Projects"). It needs the `basic` scope. The parameters used here, each from
 * that page's table:
 *
 * - `query` — "Set of space separated terms used to search project names and
 *   descriptions". All terms must match unless `or_search_query` is passed.
 * - `project_types[]` — `fixed` or `hourly`.
 * - `countries[]` — "Returns projects with at least one of the specified country codes"
 *   (example: `au, us`).
 * - `min_price` — "Returns projects with a minimum fixed price budget that's greater
 *   than or equal to the specified value in USD".
 * - `sort_field=time_updated` — "by default searches by relevance, otherwise most
 *   recently updated".
 * - `limit` and `offset` — pagination; "endpoints will not return more than 100 results"
 *   (https://developers.freelancer.com/docs/api-overview/making-a-request, "Pagination").
 * - `full_description` and `job_details` — projections: "Returns the full project
 *   description", "Returns job information". A projection is true when present; any
 *   value is ignored (same page, "Projections").
 *
 * Array parameters are sent once per value, `param[]=a&param[]=b` (same page). The
 * answer is `{ status: "success", result: { total_count, projects: [...] }, request_id }`,
 * each project with `id`, `title`, `preview_description` (or `description` with the
 * projection), `type`, `budget.minimum`/`maximum`, `currency.code`, `jobs[].name`,
 * `bid_stats.bid_count`/`bid_avg`, `time_submitted`, `time_updated`, `status` and
 * `seo_url`, as the worked example shows
 * (https://developers.freelancer.com/docs/use-cases/bidding-on-a-project, "Searching for
 * Projects"). Times are Unix seconds. A 429 carries
 * `error_code: "AuthorisationExceptionCodes.RATE_LIMITED"`
 * (https://developers.freelancer.com/docs/api-overview/rate-limiting).
 */
export const ACTIVE_PROJECTS_MAX_LIMIT = 100;

export type ProjectType = 'fixed' | 'hourly';

export interface ActiveProjectQuery {
  /** Space-separated terms; every term must appear. */
  readonly query?: string;
  readonly projectTypes?: readonly ProjectType[];
  /** ISO 3166-1 alpha-2 codes; sent in lower case as the docs' example does. */
  readonly countries?: readonly string[];
  /** In USD, as the docs define it. */
  readonly minPriceUsd?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface FreelancerProject {
  readonly id: string;
  readonly title: string;
  /** The full description with the projection, otherwise the preview. */
  readonly description: string | null;
  readonly type: string | null;
  readonly budgetMinimum: number | null;
  readonly budgetMaximum: number | null;
  readonly currencyCode: string | null;
  /** The names of the project's jobs (skills), with `job_details`. */
  readonly skills: readonly string[];
  readonly bidCount: number | null;
  readonly bidAverage: number | null;
  readonly submittedAt: Date | null;
  readonly updatedAt: Date | null;
  readonly status: string | null;
  readonly seoUrl: string | null;
  /** The project as Freelancer.com sent it, for `jobs.raw`. */
  readonly raw: Record<string, unknown>;
}

export interface ActiveProjectPage {
  readonly projects: readonly FreelancerProject[];
  readonly totalCount: number | null;
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

/** The query string, in the documented form, for the tests to hold exact. */
export function activeProjectsSearchParams(query: ActiveProjectQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.query && query.query.trim()) params.set('query', query.query.trim());
  for (const type of query.projectTypes ?? []) params.append('project_types[]', type);
  for (const country of query.countries ?? []) params.append('countries[]', country.toLowerCase());
  if (query.minPriceUsd !== undefined) params.set('min_price', query.minPriceUsd);
  params.set('sort_field', 'time_updated');
  params.set(
    'limit',
    String(Math.min(query.limit ?? ACTIVE_PROJECTS_MAX_LIMIT, ACTIVE_PROJECTS_MAX_LIMIT)),
  );
  if (query.offset) params.set('offset', String(query.offset));
  params.set('full_description', 'true');
  params.set('job_details', 'true');
  return params;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const seconds = (value: unknown): Date | null => {
  const n = num(value);
  return n === null ? null : new Date(n * 1000);
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

export function parseProject(raw: Record<string, unknown>): FreelancerProject | null {
  const id = raw.id;
  const title = str(raw.title);
  if ((typeof id !== 'number' && typeof id !== 'string') || title === null) return null;
  const budget = record(raw.budget);
  const currency = record(raw.currency);
  const bids = record(raw.bid_stats);
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return {
    id: String(id),
    title,
    description: str(raw.description) ?? str(raw.preview_description),
    type: str(raw.type),
    budgetMinimum: num(budget.minimum),
    budgetMaximum: num(budget.maximum),
    currencyCode: str(currency.code)?.toUpperCase() ?? null,
    skills: jobs
      .map((job) => str(record(job).name))
      .filter((name): name is string => name !== null),
    bidCount: num(bids.bid_count),
    bidAverage: num(bids.bid_avg),
    submittedAt: seconds(raw.time_submitted),
    updatedAt: seconds(raw.time_updated),
    status: str(raw.status),
    seoUrl: str(raw.seo_url),
    raw,
  };
}

export async function searchActiveProjects(
  config: FreelancerConfig,
  accessToken: string,
  query: ActiveProjectQuery,
  deps: { readonly fetch?: Fetch } = {},
): Promise<ActiveProjectPage> {
  const what = 'the project search';
  const url = `${config.apiUrl}/projects/0.1/projects/active/?${activeProjectsSearchParams(query).toString()}`;
  const response = await send(
    deps.fetch ?? fetch,
    url,
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
  const list = Array.isArray(result.projects) ? result.projects : null;
  if (list === null) {
    throw new FreelancerError(
      'Freelancer.com answered the project search without a projects list',
      response.status,
      null,
      str(body.request_id),
    );
  }
  return {
    projects: list
      .map((item) => parseProject(record(item)))
      .filter((project): project is FreelancerProject => project !== null),
    totalCount: num(result.total_count),
    requestId: str(body.request_id),
    rateLimit,
  };
}
