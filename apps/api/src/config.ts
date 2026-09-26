import { billingConfig, type BillingConfig } from '@arbitron/billing';
import { freelancerConfig, type FreelancerConfigResult } from '@arbitron/freelancer';
import { upworkConfig, type UpworkConfigResult } from '@arbitron/upwork';
import { EnvProblems, type Env } from '@arbitron/workers';

/**
 * The API process's settings (ARB-510, the owner's audit E-01). Required: the database,
 * Redis (without it an approval would be saved and no job created, E-02), Supabase for
 * signing in (B-06) and the web app's address, the one origin a browser may call from.
 * The marketplaces and billing are read as before: not configured, their buttons refuse
 * with the reason.
 */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly webOrigin: string;
  readonly port: number;
  /** QUEUE_PREFIX, when one Redis serves more than one environment. */
  readonly queuePrefix: string | null;
  readonly liveMode: boolean;
  readonly mcpChannelKey: string | null;
  /** TRUST_PROXY: how many proxies in front of the API may name the caller (ARB-501). */
  readonly trustProxy: boolean | number | undefined;
  readonly freelancer: FreelancerConfigResult;
  readonly upwork: UpworkConfigResult;
  readonly billing: BillingConfig;
}

export type ApiConfigResult =
  | { readonly ok: true; readonly config: ApiConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export const API_DEFAULT_PORT = 3000;

export function apiConfig(env: Env): ApiConfigResult {
  const check = new EnvProblems();
  const databaseUrl = check.requiredUrl(
    env,
    'DATABASE_URL',
    'the Postgres the API reads and writes (docs/02 B-06)',
    ['postgres', 'postgresql'],
  );
  const redisUrl = check.requiredUrl(
    env,
    'REDIS_URL',
    'the queues an approval hands its work to (docs/02 B-07)',
    ['redis', 'rediss'],
  );
  const supabaseUrl = check.requiredUrl(
    env,
    'SUPABASE_URL',
    'where sign-in tokens are checked (docs/02 B-06)',
    ['https', 'http'],
  );
  const supabaseAnonKey = check.required(
    env,
    'SUPABASE_ANON_KEY',
    'sent with each token check (docs/02 B-06)',
  );
  const appUrl = check.requiredUrl(
    env,
    'APP_URL',
    'the web app, the one origin a browser may call the API from',
    ['https', 'http'],
  );
  const port = check.port(env, API_DEFAULT_PORT);
  const liveMode = check.liveMode(env);
  const queuePrefix = check.queuePrefix(env);
  const rawTrust = env.TRUST_PROXY?.trim() ?? '';
  let trustProxy: boolean | number | undefined;
  if (rawTrust === '') trustProxy = undefined;
  else if (rawTrust === 'true' || rawTrust === 'false') trustProxy = rawTrust === 'true';
  else if (/^\d{1,2}$/.test(rawTrust)) trustProxy = Number(rawTrust);
  else check.problems.push('TRUST_PROXY must be true, false or the number of proxies in front');
  if (check.problems.length > 0) return { ok: false, problems: check.problems };

  return {
    ok: true,
    config: {
      databaseUrl,
      redisUrl,
      supabaseUrl,
      supabaseAnonKey,
      webOrigin: new URL(appUrl).origin,
      port,
      queuePrefix,
      liveMode,
      mcpChannelKey: env.MCP_CHANNEL_KEY?.trim() || null,
      trustProxy,
      freelancer: freelancerConfig(env),
      upwork: upworkConfig(env),
      billing: billingConfig(env),
    },
  };
}
