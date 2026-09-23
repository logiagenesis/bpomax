import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process stand-in for Freelancer.com (D-036): the three endpoints ARB-020 calls
 * and the project search ARB-022 calls, with the request and response shapes of the
 * official docs cited in `oauth.ts`, `users.ts` and `projects.ts`. Tests start one on a
 * free port. `pnpm --filter @arbitron/freelancer fake`
 * runs one for local development. Set FREELANCER_BASE_URL to its URL; nothing else
 * changes. It is never used unless FREELANCER_BASE_URL points at it.
 *
 * It keeps the one rule the product relies on: a code is good once, for the client and
 * redirect URI it was issued to.
 */
export interface FakeUser {
  readonly id: number;
  readonly username: string;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  /** Every value of every query parameter, for the `param[]` arrays. */
  readonly queryAll: Record<string, string[]>;
  readonly form: Record<string, string>;
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * A project as the search answers it
 * (https://developers.freelancer.com/docs/use-cases/bidding-on-a-project, "Searching for
 * Projects"). `description` is sent only with the `full_description` projection, `jobs`
 * only with `job_details`, as the docs describe those projections.
 */
export interface FakeProject {
  readonly id: number;
  readonly title: string;
  readonly preview_description: string;
  readonly description?: string;
  readonly type: 'fixed' | 'hourly';
  readonly budget: { readonly minimum: number; readonly maximum?: number };
  readonly currency: { readonly code: string; readonly id: number };
  readonly jobs?: readonly {
    readonly id: number;
    readonly name: string;
    readonly seo_url: string;
  }[];
  readonly bid_stats?: { readonly bid_count: number; readonly bid_avg: number };
  readonly time_submitted: number;
  readonly time_updated: number;
  readonly status?: string;
  readonly seo_url?: string;
  /** For the `countries[]` filter. */
  readonly location?: { readonly country?: { readonly code?: string } };
}

/** The documented example headers: 50 per minute, 1 000 per hour. */
export const FAKE_RATE_LIMIT = '50, 50;window=60, 1000;window=3600';

export interface FakeFreelancer {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly calls: FakeCall[];
  /** Who "signs in" at the authorise page next. */
  signInAs(user: FakeUser): void;
  /** The code the authorise page would put on the redirect, without a browser. */
  issueCode(redirectUri: string, user?: FakeUser): string;
  /** Every access token issued so far stops working, as after 30 days. */
  expireAccessTokens(): void;
  /** Every refresh token stops working, as after the owner revokes the app. */
  revokeRefreshTokens(): void;
  /** What the project search has to offer. */
  setProjects(projects: readonly FakeProject[]): void;
  /** The next `count` API calls answer 429, as when a rate-limit window is used up. */
  rateLimitNextCalls(count: number): void;
  close(): Promise<void>;
}

export interface FakeOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly user?: FakeUser;
  readonly port?: number;
  /** Seconds, as `expires_in`. The docs' figure by default. */
  readonly expiresIn?: number;
}

const DEFAULT_USER: FakeUser = { id: 1_000_001, username: 'sandbox-freelancer' };

function token(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiError(response: ServerResponse, status: number, message: string, code: string): void {
  json(response, status, {
    status: 'error',
    message,
    error_code: code,
    request_id: randomBytes(16).toString('hex'),
  });
}

export async function startFakeFreelancer(options: FakeOptions = {}): Promise<FakeFreelancer> {
  const clientId = options.clientId ?? 'fake-client-id';
  const clientSecret = options.clientSecret ?? 'fake-client-secret';
  const expiresIn = options.expiresIn ?? 2_592_000;
  let current = options.user ?? DEFAULT_USER;
  const codes = new Map<string, { redirectUri: string; user: FakeUser }>();
  const access = new Map<string, FakeUser>();
  const refresh = new Map<string, FakeUser>();
  const calls: FakeCall[] = [];
  let projects: readonly FakeProject[] = [];
  let rateLimitedCalls = 0;

  const issueCode = (redirectUri: string, user: FakeUser = current) => {
    const code = token('code');
    codes.set(code, { redirectUri, user });
    return code;
  };

  const issueTokens = (response: ServerResponse, user: FakeUser) => {
    const accessToken = token('access');
    const refreshToken = token('refresh');
    access.set(accessToken, user);
    refresh.set(refreshToken, user);
    json(response, 200, {
      scope: 'basic',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: 'Bearer',
    });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const raw = request.method === 'POST' ? await readBody(request) : '';
      const form = Object.fromEntries(new URLSearchParams(raw));
      const query = Object.fromEntries(url.searchParams);
      const queryAll: Record<string, string[]> = {};
      for (const key of new Set(url.searchParams.keys()))
        queryAll[key] = url.searchParams.getAll(key);
      calls.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        query,
        queryAll,
        form,
        headers: request.headers,
      });

      // The API proper: every call carries the rate-limit headers, and a used-up window
      // answers 429 in the documented shape
      // (https://developers.freelancer.com/docs/api-overview/rate-limiting).
      if (url.pathname.startsWith('/api/')) {
        if (rateLimitedCalls > 0) {
          rateLimitedCalls -= 1;
          response.setHeader('ratelimit-limit', FAKE_RATE_LIMIT);
          response.setHeader('ratelimit-remaining', '0');
          apiError(
            response,
            429,
            'You have made too many of these requests.',
            'AuthorisationExceptionCodes.RATE_LIMITED',
          );
          return;
        }
        response.setHeader('ratelimit-limit', FAKE_RATE_LIMIT);
        response.setHeader('ratelimit-remaining', '45');
      }

      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        if (query.response_type !== 'code' || query.client_id !== clientId || !query.redirect_uri) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          response.end('bad authorisation request');
          return;
        }
        const target = new URL(query.redirect_uri);
        target.searchParams.set('code', issueCode(query.redirect_uri));
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        if (form.client_id !== clientId || form.client_secret !== clientSecret) {
          json(response, 401, { status: 'error', message: 'Invalid client credentials' });
          return;
        }
        if (form.grant_type === 'authorization_code') {
          const issued = form.code ? codes.get(form.code) : undefined;
          if (!issued || issued.redirectUri !== form.redirect_uri) {
            json(response, 400, { status: 'error', message: 'Invalid authorisation code' });
            return;
          }
          codes.delete(form.code!);
          issueTokens(response, issued.user);
          return;
        }
        if (form.grant_type === 'refresh_token') {
          const user = form.refresh_token ? refresh.get(form.refresh_token) : undefined;
          if (!user) {
            json(response, 400, { status: 'error', message: 'Invalid refresh token' });
            return;
          }
          refresh.delete(form.refresh_token!);
          issueTokens(response, user);
          return;
        }
        json(response, 400, { status: 'error', message: 'Unsupported grant type' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/users/0.1/self/') {
        const header = request.headers['freelancer-oauth-v1'];
        const user = typeof header === 'string' ? access.get(header) : undefined;
        if (!user) {
          apiError(
            response,
            401,
            'You must be logged in to perform this request',
            'RestExceptionCodes.NOT_AUTHENTICATED',
          );
          return;
        }
        json(response, 200, {
          status: 'success',
          result: {
            id: user.id,
            username: user.username,
            display_name: null,
            status: { email_verified: true, payment_verified: null, phone_verified: null },
          },
          request_id: randomBytes(16).toString('hex'),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/projects/0.1/projects/active/') {
        const header = request.headers['freelancer-oauth-v1'];
        if (typeof header !== 'string' || !access.has(header)) {
          apiError(
            response,
            401,
            'You must be logged in to perform this request',
            'RestExceptionCodes.NOT_AUTHENTICATED',
          );
          return;
        }
        // The documented filters, as text matching: every `query` term in the title or
        // description; any of the `project_types[]`; any of the `countries[]`;
        // `min_price` against the minimum budget. The stand-in does no currency
        // conversion for `min_price`.
        const terms = (query.query ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((term) => term.toLowerCase());
        const types = url.searchParams.getAll('project_types[]');
        const countries = url.searchParams.getAll('countries[]').map((c) => c.toLowerCase());
        const minPrice = query.min_price ? Number(query.min_price) : null;
        const wantsDescription = url.searchParams.has('full_description');
        const wantsJobs = url.searchParams.has('job_details');
        const matching = projects
          .filter((project) => {
            const text =
              `${project.title} ${project.description ?? project.preview_description}`.toLowerCase();
            if (!terms.every((term) => text.includes(term))) return false;
            if (types.length > 0 && !types.includes(project.type)) return false;
            const country = project.location?.country?.code?.toLowerCase();
            if (countries.length > 0 && (!country || !countries.includes(country))) return false;
            if (minPrice !== null && project.budget.minimum < minPrice) return false;
            return true;
          })
          .sort((a, b) => b.time_updated - a.time_updated);
        const limit = Math.min(Number(query.limit) || 100, 100);
        const offset = Number(query.offset) || 0;
        const page = matching.slice(offset, offset + limit).map((project) => {
          const { description, jobs, location, ...rest } = project;
          return {
            ...rest,
            ...(location ? { location } : {}),
            ...(wantsDescription && description !== undefined ? { description } : {}),
            ...(wantsJobs && jobs ? { jobs } : {}),
          };
        });
        json(response, 200, {
          status: 'success',
          result: { total_count: matching.length, projects: page },
          request_id: randomBytes(16).toString('hex'),
        });
        return;
      }

      apiError(response, 404, `The fake has no ${url.pathname}`, 'RestExceptionCodes.NOT_FOUND');
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    clientId,
    clientSecret,
    calls,
    signInAs(user) {
      current = user;
    },
    issueCode,
    expireAccessTokens() {
      access.clear();
    },
    revokeRefreshTokens() {
      refresh.clear();
    },
    setProjects(list) {
      projects = list;
    },
    rateLimitNextCalls(count) {
      rateLimitedCalls = count;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
