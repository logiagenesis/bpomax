import type { Queryable } from './client.js';

/**
 * Marketplace OAuth tokens (ARB-020, migration 0017, D-041).
 *
 * The tokens live in Supabase Vault; `platform_accounts` holds only the secrets' ids.
 * These are thin, typed calls to the functions in 0017, which are the only way in:
 *
 * - `connectPlatformTokens` and `disconnectPlatformAccount` run as the signed-in person
 *   (inside `withUser`), and the database refuses anyone who is not an owner or operator
 *   of the account's org.
 * - `putPlatformTokens` and `readPlatformTokens` are service_role only: a worker
 *   refreshing or using a token. No signed-in person can read a token back.
 *
 * Nothing here logs a token, and no token is ever part of an error message.
 */
export interface PlatformTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

export interface StoreTokens {
  readonly accessToken: string;
  /** Null keeps the refresh token already stored. */
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

export async function connectPlatformTokens(
  tx: Queryable,
  accountId: string,
  tokens: StoreTokens,
): Promise<void> {
  await tx.query('select app.connect_platform_tokens($1, $2, $3, $4)', [
    accountId,
    tokens.accessToken,
    tokens.refreshToken,
    tokens.expiresAt?.toISOString() ?? null,
  ]);
}

export async function disconnectPlatformAccount(tx: Queryable, accountId: string): Promise<void> {
  await tx.query('select app.disconnect_platform_account($1)', [accountId]);
}

/** service_role: after a refresh. */
export async function putPlatformTokens(
  db: Queryable,
  accountId: string,
  tokens: StoreTokens,
): Promise<void> {
  await db.query('select app.put_platform_tokens($1, $2, $3, $4)', [
    accountId,
    tokens.accessToken,
    tokens.refreshToken,
    tokens.expiresAt?.toISOString() ?? null,
  ]);
}

/** service_role: the decrypted tokens, or null when the account holds none. */
export async function readPlatformTokens(
  db: Queryable,
  accountId: string,
): Promise<PlatformTokens | null> {
  const { rows } = await db.query<{
    access_token: string | null;
    refresh_token: string | null;
    expires_at: string | Date | null;
  }>('select access_token, refresh_token, expires_at from app.platform_tokens($1)', [accountId]);
  const row = rows[0];
  if (!row?.access_token) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}
