import type { FxQuote, Role } from '@arbitron/core';
import { isRole } from '@arbitron/core';
import type { Queryable } from '@arbitron/db';
import type { BillingConfig, Fetch as BillingFetch } from '@arbitron/billing';
import type { Fetch, FreelancerConfigResult } from '@arbitron/freelancer';
import type { Fetch as UpworkFetch, UpworkConfigResult } from '@arbitron/upwork';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * What the API hands the queues (ARB-061). Each is optional so the server can run
 * without Redis — a page then gets a plain 503 from the one button that needs a queue,
 * rather than the whole API refusing to start. The functions are typed on their job
 * data alone so this package does not depend on BullMQ; the process that starts the
 * server wires them to `enqueueSubmit` and friends from `@arbitron/workers`.
 */
export interface Enqueue {
  readonly submit?: (data: { proposalId: string; requestId?: string }) => Promise<unknown>;
  readonly draft?: (data: {
    jobId: string;
    marginEvaluationId?: string;
    requestId?: string;
  }) => Promise<unknown>;
  readonly score?: (data: { jobId: string; requestId?: string }) => Promise<unknown>;
  readonly sendMessage?: (data: { messageId: string; requestId?: string }) => Promise<unknown>;
  /** ARB-203: post an approved Freelancer.com sourcing post, and read its bids. */
  readonly sourcingPost?: (data: { postId: string; requestId?: string }) => Promise<unknown>;
  readonly sourcingCollect?: (data: { postId: string; requestId?: string }) => Promise<unknown>;
  /** ARB-204: price a candidate's quote against the job's margin rule. */
  readonly reprice?: (data: {
    candidateId: string;
    quoteMinor: string;
    requestId?: string;
  }) => Promise<unknown>;
}

export interface ServerOptions {
  readonly db: Queryable;
  /**
   * Resolves a request to a Supabase auth user id, or null. In production this verifies
   * the project's JWT — which needs B-06 (docs/02-BLOCKERS.md) — so it is injected
   * rather than assumed, and the tests supply their own.
   */
  readonly authenticate: (request: FastifyRequest) => Promise<string | null> | string | null;
  readonly logger?: boolean;
  /**
   * The origin the web app is served from (APP_URL in .env), which is the only origin a
   * browser may call this API from. Unset, no cross-origin request is allowed at all,
   * which is the safe default for a server that is not fronting a web app.
   */
  readonly webOrigin?: string | readonly string[];
  readonly enqueue?: Enqueue;
  /** The environment's LIVE_MODE switch (D-032), shown on the settings page. */
  readonly liveMode?: boolean;
  readonly now?: () => Date;
  /**
   * Freelancer.com (ARB-020): the result of `freelancerConfig(process.env)`, and a fetch
   * the tests point at the stand-in. Absent or not ok, connecting is refused with the
   * reason, naming docs/02 B-03.
   */
  readonly freelancer?: { readonly config: FreelancerConfigResult; readonly fetch?: Fetch };
  /**
   * Upwork (ARB-300): `upworkConfig(process.env)` and a fetch the tests point at the
   * stand-in. Absent or not ok, connecting is refused with the reason, naming docs/02 B-14.
   */
  readonly upwork?: { readonly config: UpworkConfigResult; readonly fetch?: UpworkFetch };
  /**
   * The FX provider (docs/02 B-10), for a payment not in rand whose rate is not typed
   * (ARB-311). Absent until B-10 is answered: the rate must then be typed with the payment.
   */
  readonly fx?: { quote(from: string, to: string): Promise<FxQuote> } | null;
  /**
   * Billing (ARB-420): `billingConfig(process.env)` and fetches the tests point at the
   * Paystack and Stripe stand-ins. A provider that is not configured refuses checkout and
   * its webhooks with the reason, naming docs/02 B-15.
   */
  readonly billing?: {
    readonly config: BillingConfig;
    readonly paystackFetch?: BillingFetch;
    readonly stripeFetch?: BillingFetch;
  };
  /**
   * The key the MCP process sends in `x-arbitron-channel-key` (MCP_CHANNEL_KEY in .env,
   * ARBITRON_MCP_CHANNEL_KEY on the MCP side). A request is labelled `mcp` only when it
   * carries this key; unset, no request can claim the MCP channel (ARB-500, S-06).
   */
  readonly mcpChannelKey?: string;
  /**
   * `GET /ready` (ARB-510): whether the API can do its work now, the database and Redis
   * both answering. Absent, the route is not served; `main.ts` always supplies it.
   */
  readonly ready?: () => Promise<{ readonly ready: boolean }>;
  /** Fastify's `trustProxy` (TRUST_PROXY): how many proxies in front may name the caller. */
  readonly trustProxy?: boolean | number;
  /** Overrides the rate limits (ARB-501); the tests use small ones. */
  readonly rateLimit?: { readonly perMinute?: number; readonly clicksPerMinute?: number };
}

/** Requests per minute per caller, and for the sign-in-free referral click (ARB-501, D-079). */
export const RATE_LIMIT_PER_MINUTE = 300;
export const REFERRAL_CLICKS_PER_MINUTE = 30;

export const CHANNEL_HEADER = 'x-arbitron-channel';
export const CHANNEL_KEY_HEADER = 'x-arbitron-channel-key';

/** Constant-time comparison of a sent value with a secret, hashed to one length first. */
export function secretMatches(sent: unknown, secret: string): boolean {
  if (typeof sent !== 'string' || secret === '') return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(sent), digest(secret));
}

/**
 * The channel a request came through (ARB-330): `mcp` for the MCP server, `web` otherwise.
 * It labels an approval; the person approving is always the signed-in one. The header
 * alone is a claim any caller can make, so it counts only with the MCP channel key the
 * API was given (ARB-500, the owner's audit S-06); a claim without it is refused rather
 * than quietly relabelled, so a misconfigured MCP process shows up at once.
 */
export function decideChannel(
  request: Pick<FastifyRequest, 'headers'>,
  mcpChannelKey: string | undefined,
): 'web' | 'mcp' | 'refused' {
  if (request.headers[CHANNEL_HEADER] === undefined) return 'web';
  if (request.headers[CHANNEL_HEADER] !== 'mcp') return 'refused';
  return mcpChannelKey && secretMatches(request.headers[CHANNEL_KEY_HEADER], mcpChannelKey)
    ? 'mcp'
    : 'refused';
}

const channels = new WeakMap<object, 'web' | 'mcp'>();

/** Records the channel `buildServer` decided for this request. */
export function rememberChannel(request: FastifyRequest, channel: 'web' | 'mcp'): void {
  channels.set(request, channel);
}

export function channelOf(request: FastifyRequest): 'web' | 'mcp' {
  return channels.get(request) ?? 'web';
}

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/** 422 for a body the server understood but will not accept; 400 is for a malformed one. */
export function invalid(errors: readonly FieldProblem[]): {
  error: string;
  errors: readonly FieldProblem[];
} {
  return { error: 'the request was not accepted', errors };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Membership {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly telegramLinked: boolean;
  readonly orgId: string;
  readonly orgName: string;
  readonly baseCurrency: string;
  readonly role: Role;
}

/**
 * The signed-in person's membership, read inside `withUser` so RLS has already decided
 * the row is theirs. Someone in several orgs gets the one where they can do the most;
 * the pages act in one org at a time.
 */
export async function currentMembership(tx: Queryable): Promise<Membership | null> {
  const { rows } = await tx.query<{
    user_id: string;
    email: string | null;
    full_name: string | null;
    telegram_chat_id: string | null;
    org_id: string;
    org_name: string;
    base_currency: string;
    role: string;
  }>(
    `select u.id as user_id, u.email, u.full_name, u.telegram_chat_id,
            m.org_id, o.name as org_name, o.base_currency, m.role::text as role
     from memberships m
     join users u on u.id = m.user_id
     join orgs o on o.id = m.org_id
     where m.user_id = app.current_user_id()
     order by (m.role = 'owner') desc, (m.role = 'operator') desc, m.created_at
     limit 1`,
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  return {
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
    telegramLinked: row.telegram_chat_id !== null,
    orgId: row.org_id,
    orgName: row.org_name,
    baseCurrency: row.base_currency,
    role: row.role,
  };
}
