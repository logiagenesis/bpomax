import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Verifies a browser's bearer token with Supabase Auth (ARB-061, docs/02 B-06).
 *
 * The token is the access token the login page received from
 * `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` and stored in the session. It
 * is verified by asking the same server who it belongs to:
 * `GET {SUPABASE_URL}/auth/v1/user` with the project's anon key and the token, which
 * answers the user (with `id`) for a valid token and 401 for anything else. That is the
 * request `supabase.auth.getUser(jwt)` makes — see
 * https://supabase.com/docs/reference/javascript/auth-getuser — and it holds whichever
 * key the project signs with, so no signing secret is kept here.
 *
 * A verified token is remembered for `ttlMs` so a page's burst of requests costs one
 * round trip. A revoked session therefore lasts at most that much longer: ten seconds
 * (ARB-500, the owner's audit S-07; it was a minute). The cache is keyed by the token's
 * SHA-256, so the process never holds a usable token it is not using, and it forgets the
 * least recently used token first when full.
 */
export interface SupabaseAuthOptions {
  readonly url: string;
  readonly anonKey: string;
  readonly fetch?: typeof fetch;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_TTL_MS = 10_000;
export const CACHE_SIZE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bearerToken(request: Pick<FastifyRequest, 'headers'>): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function supabaseAuthenticator(
  options: SupabaseAuthOptions,
): (request: Pick<FastifyRequest, 'headers'>) => Promise<string | null> {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { id: string; expiresAt: number }>();

  return async (request) => {
    const token = bearerToken(request);
    if (!token) return null;

    const key = createHash('sha256').update(token, 'utf8').digest('base64');
    const cached = cache.get(key);
    cache.delete(key);
    if (cached && cached.expiresAt > now()) {
      // Re-inserted, so the Map's order is least recently used first.
      cache.set(key, cached);
      return cached.id;
    }

    const response = await doFetch(`${base}/auth/v1/user`, {
      headers: { apikey: options.anonKey, authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) {
      throw new Error(`Supabase Auth answered ${String(response.status)} while verifying a token`);
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || !UUID.test(body.id)) return null;

    // Bound the cache: tokens are per session and a long-running server sees many.
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, { id: body.id, expiresAt: now() + ttl });
    return body.id;
  };
}
