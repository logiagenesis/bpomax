import { canWrite } from '@arbitron/core';
import { connectPlatformTokens, recordEvent, withUser } from '@arbitron/db';
import {
  DOC,
  UpworkError,
  authorizeUrl,
  currentUser,
  exchangeCode,
  type OAuthTokens,
  type UpworkConfig,
  type UpworkUser,
} from '@arbitron/upwork';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';
import { CONNECT_ATTEMPT_MINUTES, describeAccount } from './platform-accounts.js';

/**
 * Connecting an Upwork account (ARB-300), for the read-only job search: the same shape
 * as Freelancer.com's (ARB-020, D-041). The browser never sees a token. It is sent to
 * Upwork to consent (DOC.authorize), comes back to upwork-callback.html with a code, and
 * hands the code to this API, which trades it for tokens (DOC.token), asks Upwork whose
 * they are (`user`, DOC.user) and stores them in Vault (0017). The grant documents no
 * `state`, so the flow is bound to the person who started it by a single-use attempt row
 * under ten minutes old. One account per verified identity is the database's rule.
 */
const COLUMNS = `id, platform::text as platform, external_user_id, external_username,
  status::text as status, scopes, last_sync_at, plan_name, monthly_bid_allowance,
  plan_recorded_on::text`;

type AccountRow = Parameters<typeof describeAccount>[0];

export function upworkStatus(options: ServerOptions) {
  const result = options.upwork?.config;
  if (!result) {
    return {
      configured: false,
      environment: null,
      reason:
        'Upwork is not configured: UPWORK_CLIENT_ID and UPWORK_CLIENT_SECRET come from an approved Upwork API key (docs/02 B-14).',
    };
  }
  return result.ok
    ? { configured: true, environment: result.config.environment, reason: null }
    : { configured: false, environment: null, reason: result.reason };
}

function configured(options: ServerOptions): UpworkConfig {
  const result = options.upwork?.config;
  if (!result?.ok) throw refuse(503, upworkStatus(options).reason ?? 'Upwork is not configured');
  return result.config;
}

export function registerUpworkAccountRoutes(app: FastifyInstance, options: ServerOptions): void {
  const fetchDeps = () => (options.upwork?.fetch ? { fetch: options.upwork.fetch } : {});

  app.post('/v1/platform-accounts/upwork/connect', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    try {
      const config = configured(options);
      const now = options.now ? options.now() : new Date();
      const expiresAt = new Date(now.getTime() + CONNECT_ATTEMPT_MINUTES * 60_000);
      await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role)) throw refuse(403, 'your role cannot connect platform accounts');
        const { rows } = await tx.query<{ id: string }>(
          `insert into platform_connect_attempts (org_id, user_id, platform, expires_at)
           values ($1, $2, 'upwork', $3) returning id`,
          [me.orgId, me.userId, expiresAt.toISOString()],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'account.connect_started',
          actorUserId: me.userId,
          subjectTable: 'platform_connect_attempts',
          subjectId: rows[0]?.id ?? null,
          requestId: request.id,
          payload: { via: 'web', platform: 'upwork', environment: config.environment },
        });
      });
      return reply
        .code(201)
        .send({ authorizeUrl: authorizeUrl(config), expiresAt: expiresAt.toISOString() });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/platform-accounts/upwork/callback', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const code = (request.body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || code.trim().length === 0 || code.length > 2048) {
      return reply
        .code(422)
        .send(invalid([{ field: 'code', message: 'must be the code Upwork returned' }]));
    }
    try {
      const config = configured(options);
      const now = options.now ? options.now() : new Date();

      // 1. Use up this person's open attempts first, so a code is never tried twice.
      const me = await withUser(options.db, authUserId, async (tx) => {
        const who = await currentMembership(tx);
        if (!who) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(who.role)) throw refuse(403, 'your role cannot connect platform accounts');
        const { rows } = await tx.query<{ id: string }>(
          `update platform_connect_attempts set used_at = $2
            where user_id = $1 and platform = 'upwork' and used_at is null and expires_at > $2
           returning id`,
          [who.userId, now.toISOString()],
        );
        if (!rows[0])
          throw refuse(
            409,
            'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
          );
        return who;
      });

      // 2. The two calls to Upwork, outside any transaction.
      let tokens: OAuthTokens | undefined;
      let user: UpworkUser;
      try {
        tokens = await exchangeCode(config, code.trim(), { ...fetchDeps(), now: () => now });
        user = await currentUser(config, tokens.accessToken, fetchDeps());
      } catch (error) {
        if (!(error instanceof UpworkError)) throw error;
        await withUser(options.db, authUserId, async (tx) => {
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'external.call',
            actorKind: 'system',
            requestId: request.id,
            outcome: 'error',
            payload: {
              service: 'upwork',
              call: tokens ? 'graphql user' : 'oauth2/token',
              doc: tokens ? DOC.user : DOC.token,
              status: error.status,
            },
          });
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'account.connected',
            actorUserId: me.userId,
            requestId: request.id,
            outcome: 'error',
            payload: { via: 'web', platform: 'upwork', reason: error.message },
          });
        });
        throw refuse(502, `${error.message}. Nothing was connected; start again from Settings.`);
      }

      // 3. The account and its tokens, stored as the person who connected it.
      const account = await withUser(options.db, authUserId, async (tx) => {
        for (const [call, doc] of [
          ['oauth2/token', DOC.token],
          ['graphql user', DOC.user],
        ] as const) {
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'external.call',
            actorKind: 'system',
            requestId: request.id,
            outcome: 'ok',
            payload: { service: 'upwork', call, doc },
          });
        }
        const existing = (
          await tx.query<AccountRow>(
            `select ${COLUMNS} from platform_accounts where org_id = $1 and platform = 'upwork'`,
            [me.orgId],
          )
        ).rows[0];
        if (existing && existing.status === 'connected' && existing.external_user_id !== user.id) {
          throw refuse(
            409,
            `This organisation already has a connected Upwork account (${existing.external_username ?? existing.external_user_id}). Disconnect it first: one account per verified identity.`,
          );
        }
        const { rows } = existing
          ? await tx.query<AccountRow>(
              `update platform_accounts set external_user_id = $2, external_username = $3, scopes = '{}'
                where id = $1 returning ${COLUMNS}`,
              [existing.id, user.id, user.name],
            )
          : await tx.query<AccountRow>(
              `insert into platform_accounts (org_id, platform, external_user_id, external_username, scopes)
               values ($1, 'upwork', $2, $3, '{}') returning ${COLUMNS}`,
              [me.orgId, user.id, user.name],
            );
        const row = rows[0];
        if (!row) throw refuse(403, 'your role cannot connect platform accounts');
        await connectPlatformTokens(tx, row.id, tokens);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'account.connected',
          actorUserId: me.userId,
          subjectTable: 'platform_accounts',
          subjectId: row.id,
          requestId: request.id,
          outcome: 'ok',
          payload: {
            via: 'web',
            platform: 'upwork',
            environment: config.environment,
            external_user_id: user.id,
          },
        });
        const fresh = await tx.query<AccountRow>(
          `select ${COLUMNS} from platform_accounts where id = $1`,
          [row.id],
        );
        return fresh.rows[0] ?? row;
      });
      return reply.code(201).send({ account: describeAccount(account) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
