import type { Fetch } from './http.js';

/**
 * A stand-in of the three Upwork endpoints this package calls (ARB-300), answering in
 * the documented shapes (docs.ts): the token endpoint's
 * `{ access_token, refresh_token, token_type, expires_in }`, and the GraphQL endpoint's
 * `{ data }` for `user` and `marketplaceJobPostingsSearch`. It never calls Upwork.
 * Tests drive its state: the listings, a rate limit, a missing permission, a refused
 * token. Nothing here is real data.
 */
export interface FakeUpworkState {
  /** Job search nodes, newest first, in `MarketplaceJobPostingSearchResult`'s shape. */
  jobs: Record<string, unknown>[];
  user: { id: string; name: string };
  /** The access tokens the GraphQL endpoint accepts. */
  accepted: Set<string>;
  /** The refresh tokens the token endpoint accepts. */
  refreshable: Set<string>;
  codes: Set<string>;
  /** The next GraphQL call answers HTTP 429. */
  rateLimitNext: boolean;
  /** The next GraphQL call answers the documented missing-permission error. */
  permissionMissingNext: boolean;
  /** Every call, for assertions: the path, the variables and the headers asked with. */
  calls: { path: string; body: unknown; headers: Record<string, string> }[];
  issued: number;
}

export function sampleJob(
  n: number,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `~0${String(1000 + n)}`,
    ciphertext: `~01abc${String(n)}`,
    title: `Sample Upwork job ${String(n)}`,
    description: 'A sample listing from the stand-in.',
    createdDateTime: '2026-09-24T06:00:00.000Z',
    publishedDateTime: '2026-09-24T06:00:00.000Z',
    totalApplicants: 3,
    amount: { rawValue: '500.0', currency: 'USD' },
    hourlyBudgetMin: null,
    hourlyBudgetMax: null,
    skills: [{ name: 'wordpress' }, { name: 'php' }],
    job: { contractTerms: { contractType: 'FIXED' } },
    client: {
      totalSpent: { rawValue: '12345.67', currency: 'USD' },
      verificationStatus: 'VERIFIED',
      totalHires: 4,
      totalFeedback: 4.9,
      location: { country: 'United States' },
    },
    ...fields,
  };
}

export function createFakeUpwork(origin = 'https://upwork.stand-in.invalid') {
  const state: FakeUpworkState = {
    jobs: [],
    user: { id: 'up-user-1', name: 'Sample Upwork user' },
    accepted: new Set(),
    refreshable: new Set(),
    codes: new Set(['code-ok']),
    rateLimitNext: false,
    permissionMissingNext: false,
    calls: [],
    issued: 0,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const issue = () => {
    state.issued += 1;
    const access = `access-${String(state.issued)}`;
    const refresh = `refresh-${String(state.issued)}`;
    state.accepted.add(access);
    state.refreshable.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 86400,
    };
  };

  const fakeFetch: Fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== origin) throw new Error(`the stand-in does not serve ${url.origin}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '';

    if (url.pathname === '/api/v3/oauth2/token') {
      const form = new URLSearchParams(raw);
      state.calls.push({ path: url.pathname, body: Object.fromEntries(form), headers });
      const grant = form.get('grant_type');
      if (grant === 'authorization_code' && state.codes.has(form.get('code') ?? '')) {
        state.codes.delete(form.get('code') ?? '');
        return json(200, issue());
      }
      if (grant === 'refresh_token' && state.refreshable.has(form.get('refresh_token') ?? '')) {
        state.refreshable.delete(form.get('refresh_token') ?? '');
        return json(200, issue());
      }
      return json(400, { error: 'invalid_grant' });
    }

    if (url.pathname === '/graphql') {
      const body = JSON.parse(raw || '{}') as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      state.calls.push({ path: url.pathname, body, headers });
      const token = (headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.accepted.has(token)) return json(401, { errors: [{ message: 'Unauthorized' }] });
      if (state.rateLimitNext) {
        state.rateLimitNext = false;
        return json(429, { errors: [{ message: 'Too Many Requests' }] });
      }
      if (state.permissionMissingNext) {
        state.permissionMissingNext = false;
        return json(200, {
          data: null,
          errors: [
            {
              message:
                "The client or authentication token doesn't have enough oauth2 permissions/scopes to access [marketplaceJobPostingsSearch]",
            },
          ],
        });
      }
      const query = body.query ?? '';
      if (/^\s*query user\b/.test(query)) return json(200, { data: { user: state.user } });
      if (/marketplaceJobPostingsSearch\s*\(/.test(query)) {
        const filter = (body.variables?.marketPlaceJobFilter ?? {}) as {
          searchExpression_eq?: string;
          jobType_eq?: string;
          pagination_eq?: { first?: number };
        };
        const words = (filter.searchExpression_eq ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const matching = state.jobs.filter((node) => {
          const text = `${String(node.title)} ${String(node.description)}`.toLowerCase();
          const type = (node.job as { contractTerms?: { contractType?: string } } | undefined)
            ?.contractTerms?.contractType;
          return (
            (words.length === 0 || words.some((w) => text.includes(w))) &&
            (!filter.jobType_eq || type === filter.jobType_eq)
          );
        });
        const page = matching.slice(0, filter.pagination_eq?.first ?? 10);
        return json(200, {
          data: {
            marketplaceJobPostingsSearch: {
              totalCount: matching.length,
              edges: page.map((node) => ({ cursor: String(node.id), node })),
              pageInfo: {
                endCursor: page.at(-1)?.id ?? null,
                hasNextPage: matching.length > page.length,
              },
            },
          },
        });
      }
      return json(200, {
        data: null,
        errors: [{ message: 'the stand-in does not answer this query' }],
      });
    }
    return json(404, { error: 'not found' });
  };
  return { state, fetch: fakeFetch, origin };
}
