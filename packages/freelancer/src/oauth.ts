import type { FreelancerConfig } from './config.js';
import { FreelancerError, readJson, send, type Fetch } from './http.js';

/**
 * Freelancer.com OAuth 2 (ARB-020), exactly as documented at
 * https://developers.freelancer.com/docs/authentication/generating-access-tokens:
 *
 * 1. Send the person to `{accounts}/oauth/authorize` with `response_type=code`,
 *    `client_id`, `redirect_uri`, `scope=basic` ("currently, only basic scope is
 *    supported"), `advanced_scopes` (space-separated ids) and optionally `prompt`.
 * 2. They come back to the redirect URI with `?code=`.
 * 3. POST the code, form-encoded, to `{accounts}/oauth/token` with
 *    `grant_type=authorization_code`, `client_id`, `client_secret` and the same
 *    `redirect_uri`.
 * 4. The answer is `{ scope, access_token, refresh_token, expires_in, token_type }`, the
 *    access token lasting 2592000 s (30 days).
 * 5. A refresh is the same endpoint with `grant_type=refresh_token` and `refresh_token`
 *    in place of `code`.
 *
 * No `state` parameter is documented, so none is relied on. The returning code is bound
 * to the person who started the connect by a single-use attempt row instead (0017, D-041).
 */

/**
 * The advanced scopes requested, by the ids in
 * https://developers.freelancer.com/docs/authentication/advanced-scopes. Each is asked
 * for now, so that no later ticket needs the owner to connect again:
 */
export const ADVANCED_SCOPES = {
  /** 1 — post and edit projects: sourcing posts as an employer (ARB-203). */
  projectCreate: 1,
  /** 2 — manage projects, bids and milestones: required by POST /projects/0.1/bids/ (ARB-044). */
  projectManage: 2,
  /** 5 — send and read messages: the inbox and replies (ARB-120, ARB-122). */
  messaging: 5,
  /** 6 — view user and profile information: required by GET /users/0.1/self/. */
  userInformation: 6,
} as const;

export const REQUESTED_ADVANCED_SCOPES: readonly number[] = Object.values(ADVANCED_SCOPES);

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly scope: string | null;
}

export function authorizeUrl(config: FreelancerConfig): string {
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', config.clientId],
    ['redirect_uri', config.redirectUri],
    ['scope', 'basic'],
    ['advanced_scopes', REQUESTED_ADVANCED_SCOPES.join(' ')],
    // Ask which account to use, and show the permissions: the owner should see exactly
    // which Freelancer.com identity they are connecting (one per identity, 01 section H).
    ['prompt', 'select_account consent'],
  ];
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${config.accountsUrl}/oauth/authorize?${query}`;
}

export interface OAuthDeps {
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

async function tokenRequest(
  config: FreelancerConfig,
  fields: Record<string, string>,
  what: string,
  deps: OAuthDeps,
): Promise<OAuthTokens> {
  const response = await send(
    deps.fetch ?? fetch,
    `${config.accountsUrl}/oauth/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    },
    what,
  );
  const body = await readJson(response, what);
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new FreelancerError(
      `Freelancer.com answered ${what} without an access token`,
      response.status,
      null,
      null,
    );
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  const now = deps.now ? deps.now() : new Date();
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

/** Step 3: the authorisation code for tokens. */
export function exchangeCode(
  config: FreelancerConfig,
  code: string,
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  return tokenRequest(
    config,
    {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    },
    'the authorisation code',
    deps,
  );
}

/** Step 5: a new access token from the refresh token. */
export function refreshTokens(
  config: FreelancerConfig,
  refreshToken: string,
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  return tokenRequest(
    config,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    },
    'the token refresh',
    deps,
  );
}
