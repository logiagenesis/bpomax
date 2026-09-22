import { randomBytes } from 'node:crypto';
import { recordEvent, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../context.js';

/**
 * The Telegram link code (ARB-050, docs/01 section I: "Telegram link" in settings).
 *
 * A signed-in person asks for a code, sends it to the bot as `/start <code>`, and the
 * bot links that chat to them. The code is one-time and short-lived, and it is written
 * under the person's own session, so RLS decides who may make one.
 */
export const LINK_CODE_TTL_MINUTES = 10;

/** Eight characters from an alphabet without look-alikes, for typing on a phone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newLinkCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

export function registerTelegramRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.post('/v1/telegram/link-codes', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await tx.query<{ user_id: string; org_id: string }>(
        `select m.user_id, m.org_id from memberships m
         where m.user_id = app.current_user_id()
         order by (m.role = 'owner') desc, (m.role = 'operator') desc, m.created_at limit 1`,
      );
      const membership = me.rows[0];
      if (!membership) return { status: 'no_org' as const };

      const code = newLinkCode();
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000).toISOString();
      const inserted = await tx.query<{ id: string }>(
        `insert into telegram_link_codes (org_id, user_id, code, expires_at)
         values ($1, $2, $3, $4) returning id`,
        [membership.org_id, membership.user_id, code, expiresAt],
      );
      if (!inserted.rows[0]) return { status: 'refused' as const };
      return {
        status: 'ok' as const,
        code,
        expiresAt,
        orgId: membership.org_id,
        userId: membership.user_id,
      };
    }).catch((error: Error) =>
      /row-level security/i.test(error.message)
        ? { status: 'refused' as const }
        : Promise.reject(error),
    );

    if (result.status === 'no_org')
      return reply.code(403).send({ error: 'you are not a member of an organisation' });
    if (result.status === 'refused')
      return reply.code(403).send({ error: 'your role cannot link Telegram' });

    await withUser(options.db, authUserId, (tx) =>
      recordEvent(tx, {
        orgId: result.orgId,
        type: 'settings.changed',
        actorUserId: result.userId,
        subjectTable: 'telegram_link_codes',
        requestId: request.id,
        payload: { what: 'telegram_link_code_created', expiresAt: result.expiresAt },
      }),
    );
    return reply.code(201).send({ code: result.code, expiresAt: result.expiresAt });
  });
}
