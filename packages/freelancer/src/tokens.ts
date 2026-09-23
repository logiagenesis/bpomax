import { putPlatformTokens, readPlatformTokens, recordEvent, type Queryable } from '@arbitron/db';
import type { FreelancerConfig } from './config.js';
import { FreelancerError, type Fetch } from './http.js';
import { refreshTokens } from './oauth.js';

/**
 * A usable access token for a connected account, for a worker about to call
 * Freelancer.com (ARB-022 onwards). Runs as service_role, the only role that may read a
 * token (0017).
 *
 * A token with less than a day left is refreshed first. The docs give access tokens 30
 * days and a refresh grant to renew them
 * (https://developers.freelancer.com/docs/authentication/generating-access-tokens), so a
 * day's margin means a long-running job never starts with a token about to lapse. A
 * refresh that Freelancer.com refuses marks the account `expired`, and the owner must
 * connect again. Both outcomes are events. Neither event carries a token.
 */
export const REFRESH_MARGIN_MS = 24 * 3_600_000;

export class AccountNotConnectedError extends Error {
  constructor(
    readonly accountId: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'AccountNotConnectedError';
  }
}

export interface AccessTokenDeps {
  readonly db: Queryable;
  readonly config: FreelancerConfig;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

export async function freelancerAccessToken(
  deps: AccessTokenDeps,
  accountId: string,
): Promise<string> {
  const { rows } = await deps.db.query<{ org_id: string; status: string }>(
    'select org_id, status::text as status from platform_accounts where id = $1',
    [accountId],
  );
  const account = rows[0];
  if (!account) throw new AccountNotConnectedError(accountId, 'no such platform account');
  if (account.status !== 'connected') {
    throw new AccountNotConnectedError(
      accountId,
      `the Freelancer.com account is ${account.status}; connect it again in Settings`,
    );
  }
  const tokens = await readPlatformTokens(deps.db, accountId);
  if (!tokens) {
    throw new AccountNotConnectedError(accountId, 'the Freelancer.com account holds no token');
  }

  const now = deps.now ? deps.now() : new Date();
  const fresh =
    tokens.expiresAt === null || tokens.expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
  if (fresh) return tokens.accessToken;

  if (!tokens.refreshToken) {
    await markExpired(deps.db, account.org_id, accountId, 'no refresh token is stored');
    throw new AccountNotConnectedError(
      accountId,
      'the access token has lapsed and cannot be refreshed',
    );
  }

  try {
    const renewed = await refreshTokens(deps.config, tokens.refreshToken, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      now: () => now,
    });
    await putPlatformTokens(deps.db, accountId, renewed);
    await recordEvent(deps.db, {
      orgId: account.org_id,
      type: 'account.token_refreshed',
      actorKind: 'system',
      subjectTable: 'platform_accounts',
      subjectId: accountId,
      outcome: 'ok',
      payload: { expires_at: renewed.expiresAt?.toISOString() ?? null },
    });
    return renewed.accessToken;
  } catch (error) {
    // Refused (4xx): the grant is gone. A network failure or a 5xx is left for a retry.
    if (error instanceof FreelancerError && error.status >= 400 && error.status < 500) {
      await markExpired(deps.db, account.org_id, accountId, error.message);
      throw new AccountNotConnectedError(
        accountId,
        'Freelancer.com refused to renew the token; connect the account again in Settings',
      );
    }
    throw error;
  }
}

async function markExpired(
  db: Queryable,
  orgId: string,
  accountId: string,
  reason: string,
): Promise<void> {
  await db.query(`update platform_accounts set status = 'expired' where id = $1`, [accountId]);
  await recordEvent(db, {
    orgId,
    type: 'account.token_refreshed',
    actorKind: 'system',
    subjectTable: 'platform_accounts',
    subjectId: accountId,
    outcome: 'error',
    payload: { reason },
  });
}
