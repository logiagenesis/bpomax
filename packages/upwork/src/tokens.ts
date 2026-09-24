import { putPlatformTokens, readPlatformTokens, recordEvent, type Queryable } from '@arbitron/db';
import type { UpworkConfig } from './config.js';
import { UpworkError, type Fetch } from './http.js';
import { refreshTokens } from './oauth.js';

/**
 * A usable access token for a connected Upwork account, for the ingest worker. Runs as
 * service_role, the only role that may read a token (0017).
 *
 * An Upwork access token lasts 24 hours and a refresh token "2 weeks since its last
 * usage" (DOC.authentication), so a token with under an hour left is refreshed first
 * (D-066): a poll never starts on a token about to lapse, and an ingest that runs every
 * few minutes keeps the refresh token in use. A refresh Upwork refuses marks the account
 * `expired`; the owner connects again. Both outcomes are events; neither carries a token.
 */
export const UPWORK_REFRESH_MARGIN_MS = 3_600_000;

export class UpworkAccountNotConnectedError extends Error {
  constructor(
    readonly accountId: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'UpworkAccountNotConnectedError';
  }
}

export interface UpworkTokenDeps {
  readonly db: Queryable;
  readonly config: UpworkConfig;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

async function markExpired(db: Queryable, orgId: string, accountId: string, reason: string) {
  await db.query(`update platform_accounts set status = 'expired' where id = $1`, [accountId]);
  await recordEvent(db, {
    orgId,
    type: 'account.token_refreshed',
    actorKind: 'system',
    subjectTable: 'platform_accounts',
    subjectId: accountId,
    outcome: 'error',
    payload: { platform: 'upwork', reason },
  });
}

export async function upworkAccessToken(deps: UpworkTokenDeps, accountId: string): Promise<string> {
  const { rows } = await deps.db.query<{ org_id: string; status: string; platform: string }>(
    'select org_id, status::text as status, platform::text as platform from platform_accounts where id = $1',
    [accountId],
  );
  const account = rows[0];
  if (!account || account.platform !== 'upwork')
    throw new UpworkAccountNotConnectedError(accountId, 'no such Upwork account');
  if (account.status !== 'connected')
    throw new UpworkAccountNotConnectedError(
      accountId,
      `the Upwork account is ${account.status}; connect it again in Settings`,
    );
  const stored = await readPlatformTokens(deps.db, accountId);
  if (!stored)
    throw new UpworkAccountNotConnectedError(accountId, 'the Upwork account holds no token');

  const now = deps.now ? deps.now() : new Date();
  if (
    stored.expiresAt === null ||
    stored.expiresAt.getTime() - now.getTime() > UPWORK_REFRESH_MARGIN_MS
  )
    return stored.accessToken;

  if (!stored.refreshToken) {
    await markExpired(deps.db, account.org_id, accountId, 'no refresh token is stored');
    throw new UpworkAccountNotConnectedError(
      accountId,
      'the access token has lapsed and cannot be refreshed',
    );
  }
  try {
    const renewed = await refreshTokens(deps.config, stored.refreshToken, {
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
      payload: { platform: 'upwork', expires_at: renewed.expiresAt?.toISOString() ?? null },
    });
    return renewed.accessToken;
  } catch (error) {
    if (error instanceof UpworkError && error.status >= 400 && error.status < 500) {
      await markExpired(deps.db, account.org_id, accountId, error.message);
      throw new UpworkAccountNotConnectedError(
        accountId,
        'Upwork refused to renew the token; connect the account again in Settings',
      );
    }
    throw error;
  }
}
