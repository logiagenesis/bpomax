import { minorDigits, type ScannerFilters } from '@arbitron/core';
import type { UpworkConfig } from './config.js';
import { graphql, type Fetch } from './http.js';

/**
 * The marketplace job search (ARB-300), read only: `marketplaceJobPostingsSearch`
 * (DOC.jobSearch), "Search Marketplace Jobs and get their relevant details". It needs the
 * "Read marketplace Job Postings" permission (DOC.jobSearch, "Required Permissions").
 *
 * - `searchType` is always `USER_JOBS_SEARCH`: "searchType value will be ignored and
 *   always set to USER_JOBS_SEARCH".
 * - Sorted newest first: `sortAttributes: [{ field: RECENCY }]`, "Sort by recency (newest
 *   first)".
 * - One page per poll: `pagination_eq: { after: "0", first: SEARCH_PAGE_SIZE }`
 *   (DOC.pagination; `after: "0"` is "from the very first element").
 *
 * Only fields the documentation lists are asked for (DOC.jobResult, DOC.clientInfo,
 * DOC.money). `job.contractTerms.contractType` is `MarketplaceJobPosting` →
 * `MarketplaceContractTerms` → `ContractType!` (`HOURLY` or `FIXED`).
 */
export const SEARCH_PAGE_SIZE = 30;

export const JOB_SEARCH_QUERY = `query marketplaceJobPostingsSearch(
  $marketPlaceJobFilter: MarketplaceJobPostingsSearchFilter
  $searchType: MarketplaceJobPostingSearchType
  $sortAttributes: [MarketplaceJobPostingSearchSortAttribute]
) {
  marketplaceJobPostingsSearch(
    marketPlaceJobFilter: $marketPlaceJobFilter
    searchType: $searchType
    sortAttributes: $sortAttributes
  ) {
    totalCount
    edges {
      node {
        id
        ciphertext
        title
        description
        createdDateTime
        publishedDateTime
        totalApplicants
        amount { rawValue currency }
        hourlyBudgetMin { rawValue currency }
        hourlyBudgetMax { rawValue currency }
        skills { name }
        job { contractTerms { contractType } }
        client {
          totalSpent { rawValue currency }
          verificationStatus
          totalHires
          totalFeedback
          location { country }
        }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

/** `MarketplaceJobPostingsSearchFilter` fields this ingest sends (DOC.jobFilter). */
export interface JobSearchFilter {
  readonly searchExpression_eq?: string;
  readonly jobType_eq?: 'HOURLY' | 'FIXED';
  readonly pagination_eq: { readonly after: string; readonly first: number };
}

export interface BuiltSearch {
  readonly filter: JobSearchFilter;
  /** Applied here, to what comes back, because the filter cannot say it in a documented way. */
  readonly keep: (job: UpworkJob) => boolean;
  /** Scanner filters neither the search nor the listing can answer. */
  readonly notApplied: readonly string[];
}

/**
 * A scanner's filters as the search's documented fields, and what is left:
 *
 * - keywords → `searchExpression_eq` ("Generic search filter supports partial Lucene
 *   syntax"), the words joined by spaces, as for Freelancer.com.
 * - hourly → `jobType_eq` `HOURLY` or `FIXED`.
 * - `budgetMinMinor`: `budgetRange_eq` is an `IntRange` whose unit and currency are not
 *   documented, so it is not sent. A fixed-price listing whose `amount` is in the
 *   scanner's currency is kept only at or over the floor; hourly listings are kept, as the
 *   search itself does ("Hourly jobs will be returned regardless of budget").
 * - client countries: `locations_any` takes "Country or city of the client", but not in
 *   which form (name or code), and the listing's `location.country` is a string of the
 *   same undocumented form, so neither is compared with the scanner's ISO codes.
 * - categories: the org's own taxonomy, classified later (ARB-040).
 */
export function buildSearch(filters: ScannerFilters): BuiltSearch {
  const notApplied: string[] = [];
  const keywords = (filters.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const filter: {
    -readonly [K in keyof JobSearchFilter]: JobSearchFilter[K];
  } = { pagination_eq: { after: '0', first: SEARCH_PAGE_SIZE } };
  if (keywords.length > 0) filter.searchExpression_eq = keywords.join(' ');
  if (filters.hourly === true) filter.jobType_eq = 'HOURLY';
  if (filters.hourly === false) filter.jobType_eq = 'FIXED';
  let keep: (job: UpworkJob) => boolean = () => true;
  if (filters.budgetMinMinor !== undefined) {
    const currency = filters.currency?.toUpperCase();
    if (currency) {
      const floor = filters.budgetMinMinor;
      keep = (job) =>
        job.hourly ||
        job.fixed === null ||
        job.fixed.currency !== currency ||
        job.fixed.minor >= floor;
    } else {
      notApplied.push('budgetMinMinor');
    }
  }
  if (filters.clientCountriesInclude && filters.clientCountriesInclude.length > 0)
    notApplied.push('clientCountriesInclude');
  if (filters.clientCountriesExclude && filters.clientCountriesExclude.length > 0)
    notApplied.push('clientCountriesExclude');
  if (filters.categorySlugs && filters.categorySlugs.length > 0) notApplied.push('categorySlugs');
  return { filter, keep, notApplied };
}

export interface MoneyAmount {
  readonly currency: string;
  /** Whole minor units of the currency. */
  readonly minor: number;
}

/** A listing as the ingest stores it; `raw` is the node exactly as Upwork sent it. */
export interface UpworkJob {
  readonly id: string;
  readonly ciphertext: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly hourly: boolean;
  /** `amount`: the fixed budget, "null for hourly jobs or when the client did not specify". */
  readonly fixed: MoneyAmount | null;
  readonly hourlyMin: MoneyAmount | null;
  readonly hourlyMax: MoneyAmount | null;
  readonly skills: readonly string[];
  readonly publishedAt: Date | null;
  readonly applicants: number | null;
  /** From `client.verificationStatus`: true for VERIFIED, false for NOT_VERIFIED, else unknown. */
  readonly clientPaymentVerified: boolean | null;
  readonly clientTotalSpent: MoneyAmount | null;
  readonly raw: Record<string, unknown>;
}

export interface JobSearchPage {
  readonly jobs: readonly UpworkJob[];
  readonly totalCount: number | null;
}

/**
 * `Money.rawValue` is "Float point as a string, for example "1.23"" with `currency` an
 * "ISO currency code" (DOC.money): read as text into minor units, half up, with no float.
 */
export function moneyOf(value: unknown): MoneyAmount | null {
  if (typeof value !== 'object' || value === null) return null;
  const { rawValue, currency } = value as { rawValue?: unknown; currency?: unknown };
  if (typeof rawValue !== 'string' || typeof currency !== 'string') return null;
  const code = currency.trim().toUpperCase();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rawValue.trim());
  if (!/^[A-Z]{3}$/.test(code) || !match) return null;
  const digits = minorDigits(code);
  const fraction = match[2] ?? '';
  let minor = BigInt(`${match[1] ?? '0'}${fraction.slice(0, digits).padEnd(digits, '0')}`);
  if (Number(fraction.charAt(digits) || '0') >= 5) minor += 1n;
  const result = Number(minor);
  return Number.isSafeInteger(result) ? { currency: code, minor: result } : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readJob(node: Record<string, unknown>): UpworkJob | null {
  const id = node.id;
  const title = node.title;
  if (typeof id !== 'string' || id === '' || typeof title !== 'string') return null;
  const client = (
    typeof node.client === 'object' && node.client !== null ? node.client : {}
  ) as Record<string, unknown>;
  const job = (typeof node.job === 'object' && node.job !== null ? node.job : {}) as {
    contractTerms?: { contractType?: unknown } | null;
  };
  const fixed = moneyOf(node.amount);
  const hourlyMin = moneyOf(node.hourlyBudgetMin);
  const hourlyMax = moneyOf(node.hourlyBudgetMax);
  const contractType = job.contractTerms?.contractType;
  // The contract type when Upwork gives it; otherwise the documented meaning of `amount`
  // ("null for hourly jobs") with an hourly budget present.
  const hourly =
    contractType === 'HOURLY' ||
    (contractType !== 'FIXED' && fixed === null && (hourlyMin !== null || hourlyMax !== null));
  const status = client.verificationStatus;
  const skills = Array.isArray(node.skills)
    ? (node.skills as { name?: unknown }[])
        .map((s) => (typeof s?.name === 'string' ? s.name.trim() : ''))
        .filter(Boolean)
    : [];
  const applicants = node.totalApplicants;
  return {
    id,
    ciphertext: typeof node.ciphertext === 'string' ? node.ciphertext : null,
    title: title.trim(),
    description: typeof node.description === 'string' ? node.description : null,
    hourly,
    fixed: hourly ? null : fixed,
    hourlyMin: hourly ? hourlyMin : null,
    hourlyMax: hourly ? hourlyMax : null,
    skills,
    publishedAt: date(node.publishedDateTime) ?? date(node.createdDateTime),
    applicants:
      typeof applicants === 'number' && Number.isInteger(applicants) && applicants >= 0
        ? applicants
        : null,
    clientPaymentVerified: status === 'VERIFIED' ? true : status === 'NOT_VERIFIED' ? false : null,
    clientTotalSpent: moneyOf(client.totalSpent),
    raw: node,
  };
}

interface SearchData {
  marketplaceJobPostingsSearch?: {
    totalCount?: unknown;
    edges?: { node?: Record<string, unknown> | null }[] | null;
  } | null;
}

export async function searchJobs(
  config: UpworkConfig,
  accessToken: string,
  filter: JobSearchFilter,
  deps: { readonly fetch?: Fetch; readonly tenantId?: string | null } = {},
): Promise<JobSearchPage> {
  const data = await graphql<SearchData>(
    config.graphqlUrl,
    accessToken,
    JOB_SEARCH_QUERY,
    {
      marketPlaceJobFilter: filter,
      searchType: 'USER_JOBS_SEARCH',
      sortAttributes: [{ field: 'RECENCY' }],
    },
    'the job search',
    deps,
  );
  const result = data.marketplaceJobPostingsSearch;
  const jobs: UpworkJob[] = [];
  for (const edge of result?.edges ?? []) {
    const job = edge?.node ? readJob(edge.node) : null;
    if (job) jobs.push(job);
  }
  return {
    jobs,
    totalCount: typeof result?.totalCount === 'number' ? result.totalCount : null,
  };
}
