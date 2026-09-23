import type { Role } from '@arbitron/core';
import { isRole } from '@arbitron/core';
import type { Queryable } from '@arbitron/db';
import type { Fetch, FreelancerConfigResult } from '@arbitron/freelancer';
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
