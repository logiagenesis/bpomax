import { canWrite, validateAutoReply } from '@arbitron/core';
import { recordEvent, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * The org's auto-reply (ARB-121, docs/01 section I "settings (… auto-reply …)"; the
 * wording is docs/02 D-08). One per org, named "First reply". An owner or operator may
 * set it (0008 lets an operator write `auto_replies`); the person who saves it with the
 * switch on is recorded as its approver (0020), and every reply the worker sends
 * carries that approval. Nothing here sends anything.
 */
export const AUTO_REPLY_NAME = 'First reply';

interface AutoReplyRow {
  readonly id: string;
  readonly body: string;
  readonly active: boolean;
  readonly offline_after_minutes: number;
  readonly approved_by: string | null;
  readonly updated_at: string;
}

const COLUMNS = 'id, body, active, offline_after_minutes, approved_by, updated_at';

function describe(row: AutoReplyRow) {
  return {
    id: row.id,
    body: row.body,
    active: row.active,
    offlineAfterMinutes: row.offline_after_minutes,
    approvedBy: row.approved_by,
    updatedAt: row.updated_at,
  };
}

export function registerAutoReplyRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/auto-reply', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const { rows } = await tx.query<AutoReplyRow>(
        `select ${COLUMNS} from auto_replies where org_id = $1 order by updated_at desc limit 1`,
        [me.orgId],
      );
      return { row: rows[0] ?? null };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send({ autoReply: result.row ? describe(result.row) : null });
  });

  app.put('/v1/auto-reply', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const validated = validateAutoReply(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const input = validated.value;

    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role)) throw refuse(403, 'your role cannot change the auto-reply');
        const existing = await tx.query<AutoReplyRow>(
          `select ${COLUMNS} from auto_replies where org_id = $1 order by updated_at desc limit 1`,
          [me.orgId],
        );
        const before = existing.rows[0] ?? null;
        const { rows } = before
          ? await tx.query<AutoReplyRow>(
              `update auto_replies
                  set body = $2, active = $3, offline_after_minutes = $4, approved_by = $5
                where id = $1 returning ${COLUMNS}`,
              [before.id, input.body, input.active, input.offlineAfterMinutes, me.userId],
            )
          : await tx.query<AutoReplyRow>(
              `insert into auto_replies (org_id, name, body, active, offline_after_minutes, approved_by)
               values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
              [
                me.orgId,
                AUTO_REPLY_NAME,
                input.body,
                input.active,
                input.offlineAfterMinutes,
                me.userId,
              ],
            );
        const saved = rows[0];
        if (!saved) throw refuse(403, 'your role cannot change the auto-reply');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'settings.changed',
          actorUserId: me.userId,
          subjectTable: 'auto_replies',
          subjectId: saved.id,
          requestId: request.id,
          payload: {
            via: 'web',
            changed: ['autoReply'],
            before: before ? describe(before) : null,
            after: describe(saved),
          },
        });
        return saved;
      });
      return reply.send({ autoReply: describe(row) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
