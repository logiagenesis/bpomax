import { freelancerConfig, type FreelancerConfig } from '@arbitron/freelancer';
import { readLlmConfig, type LlmConfig } from '@arbitron/llm';
import { upworkConfig, type UpworkConfig } from '@arbitron/upwork';
import { EnvProblems, type Env } from './env.js';

/**
 * The workers process's settings (ARB-510, the owner's audit E-01 and E-03).
 *
 * The database and Redis are required: without them the process has nothing to do, so
 * it does not start. Everything else is a feature that is on when its settings are
 * complete and off, with the reason, when they are not: the model (B-08), Freelancer.com
 * (B-03), Upwork (B-14). A feature that is off is reported by `/ready` and at start, and
 * its queues are left for a process that has it (E-03: "flag scoring and drafting off").
 */
export interface WorkersConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly port: number;
  /** QUEUE_PREFIX, when one Redis serves more than one environment. */
  readonly queuePrefix: string | null;
  readonly liveMode: boolean;
  readonly llm: LlmConfig | null;
  readonly freelancer: FreelancerConfig | null;
  readonly upwork: UpworkConfig | null;
  /** Each feature that is off, with why. */
  readonly off: Readonly<Record<string, string>>;
}

export type WorkersConfigResult =
  | { readonly ok: true; readonly config: WorkersConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export const WORKERS_DEFAULT_PORT = 3001;

export function workersConfig(env: Env): WorkersConfigResult {
  const check = new EnvProblems();
  const databaseUrl = check.requiredUrl(
    env,
    'DATABASE_URL',
    'the Postgres the workers read and write (docs/02 B-06)',
    ['postgres', 'postgresql'],
  );
  const redisUrl = check.requiredUrl(env, 'REDIS_URL', 'the queues (docs/02 B-07)', [
    'redis',
    'rediss',
  ]);
  const port = check.port(env, WORKERS_DEFAULT_PORT);
  const liveMode = check.liveMode(env);
  const queuePrefix = check.queuePrefix(env);
  if (check.problems.length > 0) return { ok: false, problems: check.problems };

  const off: Record<string, string> = {};
  const llm = readLlmConfig({ ...env });
  if (!llm.ok) {
    // A model named but not priced is a mistake to fix, not a feature switched off.
    const unpriced = llm.problems.filter((p) => /has no price/.test(p.message));
    if (unpriced.length > 0)
      return { ok: false, problems: unpriced.map((p) => `${p.variable} ${p.message}`) };
    off.model = `${llm.problems.map((p) => `${p.variable} ${p.message}`).join('; ')}: scoring, estimating, drafting, discovery and briefs are off`;
  }
  const freelancer = freelancerConfig(env);
  if (!freelancer.ok) off.freelancer = freelancer.reason;
  const upwork = upworkConfig(env);
  if (!upwork.ok) off.upwork = upwork.reason;

  return {
    ok: true,
    config: {
      databaseUrl,
      redisUrl,
      port,
      queuePrefix,
      liveMode,
      llm: llm.ok ? llm.config : null,
      freelancer: freelancer.ok ? freelancer.config : null,
      upwork: upwork.ok ? upwork.config : null,
      off,
    },
  };
}
