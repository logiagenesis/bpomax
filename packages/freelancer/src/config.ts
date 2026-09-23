/**
 * Freelancer.com connection settings (ARB-020), read from docs/01 section J's variables:
 * FREELANCER_BASE_URL, FREELANCER_CLIENT_ID, FREELANCER_CLIENT_SECRET and
 * FREELANCER_REDIRECT_URI.
 *
 * Hosts, from the official docs:
 * - API: `https://www.freelancer.com/api/` and, for the sandbox,
 *   `https://www.freelancer-sandbox.com/api/`
 *   (https://developers.freelancer.com/docs/api-overview/sandbox-environment).
 * - OAuth: `https://accounts.freelancer.com/oauth/authorize` and
 *   `https://accounts.freelancer-sandbox.com/oauth/authorize`; tokens from `/oauth/token`
 *   on the accounts host
 *   (https://developers.freelancer.com/docs/authentication/generating-access-tokens).
 *
 * So the accounts host is the site host with `www.` replaced by `accounts.`. Any other
 * base URL is a stand-in (the fake in `fake.ts`), which serves both from one origin. A
 * stand-in is never a default. It is used only when FREELANCER_BASE_URL names one, and
 * the settings page says so (D-036).
 */
export type FreelancerEnvironment = 'production' | 'sandbox' | 'stand-in';

export interface FreelancerConfig {
  readonly environment: FreelancerEnvironment;
  /** The site, e.g. https://www.freelancer-sandbox.com, with no trailing slash. */
  readonly baseUrl: string;
  /** `${baseUrl}/api` */
  readonly apiUrl: string;
  /** The OAuth host, e.g. https://accounts.freelancer-sandbox.com */
  readonly accountsUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export type FreelancerConfigResult =
  | { readonly ok: true; readonly config: FreelancerConfig }
  | { readonly ok: false; readonly missing: readonly string[]; readonly reason: string };

const REQUIRED = [
  'FREELANCER_BASE_URL',
  'FREELANCER_CLIENT_ID',
  'FREELANCER_CLIENT_SECRET',
  'FREELANCER_REDIRECT_URI',
] as const;

const KNOWN_HOSTS: Record<string, FreelancerEnvironment> = {
  'www.freelancer.com': 'production',
  'www.freelancer-sandbox.com': 'sandbox',
};

export function freelancerConfig(
  env: Readonly<Record<string, string | undefined>>,
): FreelancerConfigResult {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `Freelancer.com is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. They come from the Freelancer.com developer app (docs/02 B-03).`,
    };
  }
  let base: URL;
  try {
    base = new URL(env.FREELANCER_BASE_URL!.trim());
  } catch {
    return {
      ok: false,
      missing: ['FREELANCER_BASE_URL'],
      reason: 'FREELANCER_BASE_URL is not a URL.',
    };
  }
  const environment = KNOWN_HOSTS[base.host] ?? 'stand-in';
  const baseUrl = base.origin;
  const accountsUrl =
    environment === 'stand-in'
      ? baseUrl
      : `${base.protocol}//${base.host.replace(/^www\./, 'accounts.')}`;
  return {
    ok: true,
    config: {
      environment,
      baseUrl,
      apiUrl: `${baseUrl}/api`,
      accountsUrl,
      clientId: env.FREELANCER_CLIENT_ID!.trim(),
      clientSecret: env.FREELANCER_CLIENT_SECRET!.trim(),
      redirectUri: env.FREELANCER_REDIRECT_URI!.trim(),
    },
  };
}
