import { canWrite } from '@arbitron/core';
import {
  connectPlatformTokens,
  disconnectPlatformAccount,
  recordEvent,
  withUser,
  type Queryable,
} from '@arbitron/db';
import {
  FreelancerError,
  authorizeUrl,
  exchangeCode,
  getSelf,
  REQUESTED_ADVANCED_SCOPES,
  type FreelancerConfig,
  type FreelancerSelf,
  type OAuthTokens,
} from '@arbitron/freelancer';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, UUID, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Connecting and disconnecting a Freelancer.com account (ARB-020, docs/01 sections D and
 * H). The browser never sees a token: it is sent to Freelancer.com to consent, comes back
 * to the web app's callback page with a code, and hands that code to this API. The API
 * trades it for tokens, asks Freelancer.com whose they are, and stores them in Vault
 * (0017, D-041).
 *
 * The flow is bound to the person who started it by a single-use attempt row under ten
 * minutes old, because Freelancer.com documents no `state` parameter. One account per
 * verified identity is the database's rule (unique per platform and user id, across
 * every org), reported here in words.
 *
 * Connecting is not an outbound action to a client or a marketplace listing, so LIVE_MODE
 * does not gate it: the sandbox connect is the acceptance clause (D-044).
 */
export const CONNECT_ATTEMPT_MINUTES = 10;

interface AccountRow {
  readonly id: string;
  readonly platform: string;
  readonly external_user_id: string;
  readonly external_username: string | null;
  readonly status: string;
  readonly scopes: string[];
  readonly last_sync_at: string | null;
  readonly plan_name: string | null;
  readonly monthly_bid_allowance: number | null;
  readonly plan_recorded_on: string | null;
}

const ACCOUNT_COLUMNS = `id, platform::text as platform, external_user_id, external_username,
  status::text as status, scopes, last_sync_at, plan_name, monthly_bid_allowance,
  plan_recorded_on::text`;

export function describeAccount(account: AccountRow) {
  return {
    id: account.id,
    platform: account.platform,
    externalUserId: account.external_user_id,
    externalUsername: account.external_username,
    status: account.status,
    scopes: account.scopes,
    lastSyncAt: account.last_sync_at,
    planName: account.plan_name,
    monthlyBidAllowance: account.monthly_bid_allowance,
    planRecordedOn: account.plan_recorded_on,
  };
}

/** What the settings page shows beside "Connect Freelancer.com". */
export function freelancerStatus(options: ServerOptions) {
  const result = options.freelancer?.config;
  if (!result) {
    return {
      configured: false,
      environment: null,
      reason:
        'Freelancer.com is not configured: FREELANCER_BASE_URL, FREELANCER_CLIENT_ID, FREELANCER_CLIENT_SECRET and FREELANCER_REDIRECT_URI come from the Freelancer.com developer app (docs/02 B-03).',
    };
  }
  return result.ok
    ? { configured: true, environment: result.config.environment, reason: null }
    : { configured: false, environment: null, reason: result.reason };
}

function configured(options: ServerOptions): FreelancerConfig {
  const result = options.freelancer?.config;
  if (!result?.ok) throw refuse(503, freelancerStatus(options).reason ?? 'not configured');
  return result.config;
}

async function externalCall(
  tx: Queryable,
  orgId: string,
  requestId: string,
  call: string,
  outcome: 'ok' | 'error',
  detail: Record<string, unknown>,
): Promise<void> {
  await recordEvent(tx, {
    orgId,
    type: 'external.call',
    actorKind: 'system',
    requestId,
    outcome,
    payload: { service: 'freelancer', call, ...detail },
  });
}

export function registerPlatformAccountRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.post('/v1/platform-accounts/freelancer/connect', async (request, reply) => {
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
           values ($1, $2, 'freelancer', $3) returning id`,
          [me.orgId, me.userId, expiresAt.toISOString()],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'account.connect_started',
          actorUserId: me.userId,
          subjectTable: 'platform_connect_attempts',
          subjectId: rows[0]?.id ?? null,
          requestId: request.id,
          payload: { via: 'web', platform: 'freelancer', environment: config.environment },
        });
      });
      return reply
        .code(201)
        .send({ authorizeUrl: authorizeUrl(config), expiresAt: expiresAt.toISOString() });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/platform-accounts/freelancer/callback', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const code = (request.body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || code.trim().length === 0 || code.length > 2048) {
      return reply
        .code(422)
        .send(invalid([{ field: 'code', message: 'must be the code Freelancer.com returned' }]));
    }

    try {
      const config = configured(options);
      const now = options.now ? options.now() : new Date();

      // 1. Use up this person's attempts first, so a code is never tried twice, even when
      //    the exchange below fails.
      const me = await withUser(options.db, authUserId, async (tx) => {
        const who = await currentMembership(tx);
        if (!who) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(who.role)) throw refuse(403, 'your role cannot connect platform accounts');
        // Every open attempt of this person's is used up: one consent, one code.
        const { rows } = await tx.query<{ id: string }>(
          `update platform_connect_attempts set used_at = $2
            where user_id = $1 and platform = 'freelancer' and used_at is null
              and expires_at > $2
           returning id`,
          [who.userId, now.toISOString()],
        );
        if (!rows[0]) {
          throw refuse(
            409,
            'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
          );
        }
        return who;
      });

      // 2. The two calls to Freelancer.com, outside any transaction.
      let tokens: OAuthTokens | undefined;
      let self: FreelancerSelf;
      try {
        tokens = await exchangeCode(config, code.trim(), {
          ...(options.freelancer?.fetch ? { fetch: options.freelancer.fetch } : {}),
          now: () => now,
        });
        self = await getSelf(config, tokens.accessToken, {
          ...(options.freelancer?.fetch ? { fetch: options.freelancer.fetch } : {}),
        });
      } catch (error) {
        if (!(error instanceof FreelancerError)) throw error;
        await withUser(options.db, authUserId, async (tx) => {
          await externalCall(
            tx,
            me.orgId,
            request.id,
            tokens ? 'users/0.1/self' : 'oauth/token',
            'error',
            {
              status: error.status,
              error_code: error.errorCode,
              request_id: error.requestId,
            },
          );
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'account.connected',
            actorUserId: me.userId,
            requestId: request.id,
            outcome: 'error',
            payload: { via: 'web', platform: 'freelancer', reason: error.message },
          });
        });
        throw refuse(502, `${error.message}. Nothing was connected; start again from Settings.`);
      }

      // 3. Store the account and its tokens as the person who connected it.
      const account = await withUser(options.db, authUserId, async (tx) => {
        await externalCall(tx, me.orgId, request.id, 'oauth/token', 'ok', {});
        await externalCall(tx, me.orgId, request.id, 'users/0.1/self', 'ok', {
          request_id: self.requestId,
        });
        const existing = (
          await tx.query<AccountRow>(
            `select ${ACCOUNT_COLUMNS} from platform_accounts
              where org_id = $1 and platform = 'freelancer'`,
            [me.orgId],
          )
        ).rows[0];
        if (existing && existing.status === 'connected' && existing.external_user_id !== self.id) {
          throw refuse(
            409,
            `This organisation already has a connected Freelancer.com account (${existing.external_username ?? existing.external_user_id}). Disconnect it first: one account per verified identity.`,
          );
        }
        const scopes = ['basic', ...REQUESTED_ADVANCED_SCOPES.map(String)];
        const { rows } = existing
          ? await tx.query<AccountRow>(
              `update platform_accounts
                  set external_user_id = $2, external_username = $3, scopes = $4
                where id = $1 returning ${ACCOUNT_COLUMNS}`,
              [existing.id, self.id, self.username, scopes],
            )
          : await tx.query<AccountRow>(
              `insert into platform_accounts
                 (org_id, platform, external_user_id, external_username, scopes)
               values ($1, 'freelancer', $2, $3, $4) returning ${ACCOUNT_COLUMNS}`,
              [me.orgId, self.id, self.username, scopes],
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
            platform: 'freelancer',
            environment: config.environment,
            external_user_id: self.id,
            external_username: self.username,
            replaced_external_user_id:
              existing && existing.external_user_id !== self.id ? existing.external_user_id : null,
          },
        });
        const fresh = await tx.query<AccountRow>(
          `select ${ACCOUNT_COLUMNS} from platform_accounts where id = $1`,
          [row.id],
        );
        return fresh.rows[0] ?? row;
      });
      return reply.code(201).send({ account: describeAccount(account) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/platform-accounts/:id/disconnect', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const account = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        // Visible first, under RLS: another org's account answers 404, as scanners do (D-019).
        const visible = await tx.query<AccountRow>(
          `select ${ACCOUNT_COLUMNS} from platform_accounts where id = $1`,
          [id],
        );
        if (!visible.rows[0]) throw refuse(404, 'no such platform account');
        if (!canWrite(me.role)) throw refuse(403, 'your role cannot disconnect platform accounts');
        await disconnectPlatformAccount(tx, id);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'account.disconnected',
          actorUserId: me.userId,
          subjectTable: 'platform_accounts',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            platform: visible.rows[0].platform,
            external_user_id: visible.rows[0].external_user_id,
          },
        });
        const { rows } = await tx.query<AccountRow>(
          `select ${ACCOUNT_COLUMNS} from platform_accounts where id = $1`,
          [id],
        );
        return rows[0]!;
      });
      return reply.send({ account: describeAccount(account) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
