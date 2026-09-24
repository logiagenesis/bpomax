import { DOC } from './docs.js';

/**
 * Upwork connection settings (ARB-300). docs/01 section J names UPWORK_CLIENT_ID and
 * UPWORK_CLIENT_SECRET (the API key, docs/02 B-14). The authorisation code grant also
 * needs the callback URL registered with the key; section J names no variable for it, so
 * it is this app's own page, `${APP_URL}/upwork-callback.html` (D-066), and that is the
 * address to register with the key.
 *
 * The hosts are the documented ones:
 * - GraphQL: `https://api.upwork.com/graphql` (DOC.endpoint);
 * - authorise: `GET https://www.upwork.com/ab/account-security/oauth2/authorize`
 *   (DOC.authorize);
 * - token: `POST https://www.upwork.com/api/v3/oauth2/token` (DOC.token).
 *
 * Upwork documents no sandbox. UPWORK_BASE_URL, for tests and local development only (it is
 * not in docs/01 section J, so not in .env.example), names a stand-in (`fake.ts`) serving
 * the same three paths from one origin when set to anything but an upwork.com host. It is
 * never a default, and the settings page says when it is in use (D-036).
 */
export type UpworkEnvironment = 'production' | 'stand-in';

export interface UpworkConfig {
  readonly environment: UpworkEnvironment;
  readonly graphqlUrl: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export type UpworkConfigResult =
  | { readonly ok: true; readonly config: UpworkConfig }
  | { readonly ok: false; readonly missing: readonly string[]; readonly reason: string };

const REQUIRED = ['UPWORK_CLIENT_ID', 'UPWORK_CLIENT_SECRET', 'APP_URL'] as const;

/** The page Upwork sends the browser back to. */
export const UPWORK_CALLBACK_PAGE = 'upwork-callback.html';

export const UPWORK_PRODUCTION = {
  graphqlUrl: 'https://api.upwork.com/graphql',
  authorizeUrl: 'https://www.upwork.com/ab/account-security/oauth2/authorize',
  tokenUrl: 'https://www.upwork.com/api/v3/oauth2/token',
} as const;

export function upworkConfig(
  env: Readonly<Record<string, string | undefined>>,
): UpworkConfigResult {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `Upwork is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. They come from an approved Upwork API key (docs/02 B-14; ${DOC.preparation}).`,
    };
  }
  let redirectUri: string;
  try {
    const app = env.APP_URL!.trim();
    redirectUri = new URL(UPWORK_CALLBACK_PAGE, app.endsWith('/') ? app : `${app}/`).toString();
  } catch {
    return { ok: false, missing: ['APP_URL'], reason: 'APP_URL is not a URL.' };
  }
  const credentials = {
    clientId: env.UPWORK_CLIENT_ID!.trim(),
    clientSecret: env.UPWORK_CLIENT_SECRET!.trim(),
    redirectUri,
  };
  const override = env.UPWORK_BASE_URL?.trim();
  if (!override) {
    return {
      ok: true,
      config: { environment: 'production', ...UPWORK_PRODUCTION, ...credentials },
    };
  }
  let base: URL;
  try {
    base = new URL(override);
  } catch {
    return { ok: false, missing: ['UPWORK_BASE_URL'], reason: 'UPWORK_BASE_URL is not a URL.' };
  }
  if (base.hostname === 'upwork.com' || base.hostname.endsWith('.upwork.com')) {
    return {
      ok: true,
      config: { environment: 'production', ...UPWORK_PRODUCTION, ...credentials },
    };
  }
  const origin = base.origin;
  return {
    ok: true,
    config: {
      environment: 'stand-in',
      graphqlUrl: `${origin}/graphql`,
      authorizeUrl: `${origin}/ab/account-security/oauth2/authorize`,
      tokenUrl: `${origin}/api/v3/oauth2/token`,
      ...credentials,
    },
  };
}
