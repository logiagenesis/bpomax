import {
  canApprove,
  canWrite,
  outboundMessageState,
  validateMessageDraft,
  validateRejection,
  type OutboundMessageState,
} from '@arbitron/core';
import { recordEvent, textFingerprint, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  channelOf,
  currentMembership,
  invalid,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Outbound messages (ARB-122, docs/01 section H: "every outbound action (bid, message,
 * …) requires approval"; section I: the approvals page lists "all pending outbound
 * items"). A reply is drafted on a thread, waits for a person, and once approved is
 * handed to the `send-message` worker, which holds the live gate (D-032) and the
 * documented call. Nothing here sends anything.
 *
 * The rules are the bids' (routes/proposals.ts, D-033): an approval names the person who
 * gave it (0009's restrictive policy makes sure it is the caller's own name); an edit
 * clears the approval, because the old one covered the old words; a rejection records
 * its reason; a sent message can be changed by none of them. 0003's constraint refuses
 * a sent app message without its approval, whatever tries to write it.
 */
export interface OutboundRow {
  readonly id: string;
  readonly thread_id: string;
  readonly external_thread_id: string;
  readonly client_handle: string | null;
  readonly job_id: string | null;
  readonly job_title: string | null;
  readonly body: string;
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_via: string | null;
  readonly sent_at: string | null;
  readonly rejected_at: string | null;
  readonly failure_reason: string | null;
  readonly external_message_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_inbound_body: string | null;
  readonly last_inbound_at: string | null;
}

const STATES = new Set(['queued', 'approved', 'sent', 'rejected', 'failed', 'all']);
const LIST_LIMIT = 200;

const OUTBOUND_SQL = `
  select m.id, m.thread_id, t.external_thread_id, t.client_handle, t.job_id, j.title as job_title,
         m.body, m.approved_by, a.full_name as approved_by_name, m.approved_via::text as approved_via,
         m.sent_at, m.rejected_at, m.failure_reason, m.external_message_id, m.created_at, m.updated_at,
         li.body as last_inbound_body, li.sent_at as last_inbound_at
    from messages m
    join threads t on t.id = m.thread_id
    left join jobs j on j.id = t.job_id
    left join users a on a.id = m.approved_by
    left join lateral (
      select body, sent_at from messages
       where thread_id = m.thread_id and direction = 'in'
       order by sent_at desc nulls last, created_at desc limit 1
    ) li on true
   where m.direction = 'out' and m.origin = 'app'`;

export function describeOutbound(row: OutboundRow) {
  return {
    id: row.id,
    threadId: row.thread_id,
    externalThreadId: row.external_thread_id,
    clientHandle: row.client_handle,
    jobId: row.job_id,
    jobTitle: row.job_title,
    body: row.body,
    state: outboundMessageState({
      sentAt: row.sent_at,
      approvedBy: row.approved_by,
      rejectedAt: row.rejected_at,
      failureReason: row.failure_reason,
    }),
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedVia: row.approved_via,
    sentAt: row.sent_at,
    rejectedAt: row.rejected_at,
    failureReason: row.failure_reason,
    externalMessageId: row.external_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInbound:
      row.last_inbound_body === null
        ? null
        : { body: row.last_inbound_body, sentAt: row.last_inbound_at },
  };
}

async function loadOutbound(tx: Queryable, id: string): Promise<OutboundRow | null> {
  const { rows } = await tx.query<OutboundRow>(`${OUTBOUND_SQL} and m.id = $1`, [id]);
  return rows[0] ?? null;
}

async function approver(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canApprove(me.role)) throw refuse(403, 'your role can view messages but not change them');
  return me;
}

function cannot(state: OutboundMessageState, verb: string): never {
  throw refuse(
    409,
    state === 'sent'
      ? 'This message has already been sent.'
      : state === 'approved'
        ? `This message is already approved, so it cannot be ${verb}.`
        : state === 'rejected'
          ? `This message is rejected, so it cannot be ${verb}. Edit it to bring it back.`
          : `This message ${state === 'failed' ? 'failed to send' : 'is waiting'}, so it cannot be ${verb}. Edit it to bring it back.`,
  );
}

export function registerMessageRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/outbound-messages', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const wanted = (request.query as { status?: string }).status ?? 'queued';
    if (!STATES.has(wanted))
      return reply.code(400).send({ error: `status must be one of ${[...STATES].join(', ')}` });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const { rows } = await tx.query<OutboundRow>(
        `${OUTBOUND_SQL} order by m.created_at desc limit ${String(LIST_LIMIT)}`,
      );
      return rows;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    const messages = result
      .map(describeOutbound)
      .filter((m) => wanted === 'all' || m.state === wanted);
    return reply.send({ messages });
  });

  app.post('/v1/threads/:id/messages', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateMessageDraft(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));

    try {
      const message = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const thread = await tx.query<{ id: string; status: string }>(
          `select id, status::text as status from threads where id = $1`,
          [id],
        );
        if (!thread.rows[0]) throw refuse(404, 'no such thread');
        if (!canWrite(me.role)) throw refuse(403, 'your role can view messages but not write them');
        const { rows } = await tx.query<{ id: string }>(
          `insert into messages (org_id, thread_id, direction, body, origin)
           values ($1, $2, 'out', $3, 'app') returning id`,
          [me.orgId, id, validated.value.text],
        );
        const row = rows[0];
        if (!row) throw refuse(403, 'your role can view messages but not write them');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'message.drafted',
          actorUserId: me.userId,
          subjectTable: 'messages',
          subjectId: row.id,
          requestId: request.id,
          payload: { via: 'web', thread_id: id, bodyLength: validated.value.text.length },
        });
        return (await loadOutbound(tx, row.id))!;
      });
      return reply.code(201).send({ message: describeOutbound(message) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/outbound-messages/:id/approve', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const message = await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        const before = await loadOutbound(tx, id);
        if (!before) throw refuse(404, 'no such message');
        const state = describeOutbound(before).state;
        if (state !== 'queued') cannot(state, 'approved');
        const { rows } = await tx.query<{ id: string }>(
          `update messages set approved_by = $2, approved_via = $3::approval_channel
            where id = $1 and approved_by is null and sent_at is null and rejected_at is null
            returning id`,
          [id, me.userId, channelOf(request)],
        );
        if (!rows[0])
          throw refuse(403, 'you do not have permission to approve messages in this org');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'message.approved',
          actorUserId: me.userId,
          subjectTable: 'messages',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: channelOf(request),
            thread_id: before.thread_id,
            bodyLength: before.body.length,
          },
        });
        return (await loadOutbound(tx, id))!;
      });
      if (options.enqueue?.sendMessage) {
        await options.enqueue.sendMessage({ messageId: id, requestId: request.id });
      }
      return reply.send({
        message: describeOutbound(message),
        queued: Boolean(options.enqueue?.sendMessage),
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/outbound-messages/:id/reject', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateRejection(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    try {
      const message = await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        const before = await loadOutbound(tx, id);
        if (!before) throw refuse(404, 'no such message');
        const state = describeOutbound(before).state;
        if (state === 'sent' || state === 'rejected') cannot(state, 'rejected');
        const now = options.now ? options.now() : new Date();
        const { rows } = await tx.query<{ id: string }>(
          `update messages set rejected_at = $2, failure_reason = $3, approved_by = null, approved_via = null
            where id = $1 and sent_at is null returning id`,
          [id, now.toISOString(), validated.value.text],
        );
        if (!rows[0])
          throw refuse(403, 'you do not have permission to reject messages in this org');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'message.rejected',
          actorUserId: me.userId,
          subjectTable: 'messages',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            reason: textFingerprint(validated.value.text),
            state_before: state,
          },
        });
        return (await loadOutbound(tx, id))!;
      });
      return reply.send({ message: describeOutbound(message) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.patch('/v1/outbound-messages/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateMessageDraft(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    try {
      const message = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role))
          throw refuse(403, 'your role can view messages but not change them');
        const before = await loadOutbound(tx, id);
        if (!before) throw refuse(404, 'no such message');
        const state = describeOutbound(before).state;
        if (state === 'sent') cannot(state, 'edited');
        // New words need a new approval: the old one covered the old words (D-033).
        const { rows } = await tx.query<{ id: string }>(
          `update messages
              set body = $2, approved_by = null, approved_via = null, rejected_at = null, failure_reason = null
            where id = $1 and sent_at is null returning id`,
          [id, validated.value.text],
        );
        if (!rows[0]) throw refuse(403, 'you do not have permission to edit messages in this org');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'message.edited',
          actorUserId: me.userId,
          subjectTable: 'messages',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', bodyLength: validated.value.text.length, state_before: state },
        });
        return (await loadOutbound(tx, id))!;
      });
      return reply.send({ message: describeOutbound(message) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
