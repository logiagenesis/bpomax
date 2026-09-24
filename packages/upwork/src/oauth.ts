import type { UpworkConfig } from './config.js';
import { UpworkError, tokenCall, type Fetch } from './http.js';

/**
 * Upwork OAuth 2.0, the Authorization Code Grant exactly as documented (DOC.authorize,
 * DOC.token, DOC.refresh):
 *
 * 1. Send the person to `GET …/ab/account-security/oauth2/authorize` with
 *    `response_type=code`, `client_id` and `redirect_uri`. No scope parameter is
 *    documented: the key's permissions are chosen when the key is requested.
 * 2. They come back to the redirect URI with `?code=`.
 * 3. `POST …/api/v3/oauth2/token`, form-encoded, with `grant_type=authorization_code`,
 *    `client_id`, `client_secret`, `code` and `redirect_uri`. The answer is
 *    `{ access_token, refresh_token, token_type: "Bearer", expires_in: 86400 }`: "TTL for
 *    an access token is 24 hours; TTL for a refresh token is 2 weeks since its last
 *    usage."
 * 4. A refresh is the same endpoint with `grant_type=refresh_token`, `client_id`,
 *    `client_secret` and `refresh_token`.
 *
 * The grant without PKCE documents no `state`, so none is relied on: the returning code
 * is bound to the person who started the connect by a single-use attempt row, as for
 * Freelancer.com (0017, D-041).
 */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

export interface OAuthDeps {
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

export function authorizeUrl(config: UpworkConfig): string {
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', config.clientId],
    ['redirect_uri', config.redirectUri],
  ];
  return `${config.authorizeUrl}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

async function tokens(
  config: UpworkConfig,
  fields: Record<string, string>,
  what: string,
  deps: OAuthDeps,
): Promise<OAuthTokens> {
  const body = await tokenCall(config.tokenUrl, fields, what, deps.fetch);
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0)
    throw new UpworkError(`Upwork answered ${what} without an access token`, 200);
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  const now = deps.now ? deps.now() : new Date();
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
  };
}

/** Step 3: the authorisation code for tokens. */
export function exchangeCode(
  config: UpworkConfig,
  code: string,
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  return tokens(
    config,
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    },
    'the authorisation code',
    deps,
  );
}

/** Step 4: new tokens from the refresh token. */
export function refreshTokens(
  config: UpworkConfig,
  refreshToken: string,
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  return tokens(
    config,
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    'the token refresh',
    deps,
  );
}
