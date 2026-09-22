import type { Queryable } from '@arbitron/db';
import type { FastifyRequest } from 'fastify';

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
