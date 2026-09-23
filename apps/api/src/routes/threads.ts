import { outboundMessageState, type OutboundMessageState } from '@arbitron/core';
import { withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, UUID, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Conversations (ARB-140, docs/01 section I: "conversations (threads, discovery
 * progress, brief builder)"). Read-only: the list of an organisation's threads with
 * where each one stands, and one thread with its messages in order. Everything a
 * person can do from the page goes through the routes that own it: a reply through
 * routes/messages.ts (ARB-122), discovery through routes/discovery.ts (ARB-130), the
 * brief through routes/briefs.ts (ARB-131). Nothing here writes.
 */
export const THREAD_PAGE_LIMIT = 50;
export const THREAD_MAX_LIMIT = 200;
const STATUSES = new Set(['open', 'awaiting_client', 'awaiting_operator', 'closed']);

interface ThreadRow {
  readonly id: string;
  readonly platform: string;
  readonly external_thread_id: string;
  readonly job_id: string | null;
  readonly job_title: string | null;
  readonly client_handle: string | null;
  readonly status: string;
  readonly last_message_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly message_count: number;
  readonly pending_replies: number;
  readonly last_direction: string | null;
  readonly last_body: string | null;
  readonly last_sent_at: string | null;
  readonly discovery_completeness: string | null;
  readonly brief_id: string | null;
  readonly brief_version: number | null;
  readonly brief_locked: boolean | null;
}

interface MessageRow {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly origin: 'app' | 'platform';
  readonly body: string;
  readonly sent_at: string | null;
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_via: string | null;
  readonly rejected_at: string | null;
  readonly failure_reason: string | null;
  readonly external_message_id: string | null;
  readonly created_at: string;
}

const THREAD_SQL = `
  select t.id, t.platform::text as platform, t.external_thread_id, t.job_id, j.title as job_title,
         t.client_handle, t.status::text as status, t.last_message_at, t.created_at, t.updated_at,
         (select count(*)::int from messages m where m.thread_id = t.id) as message_count,
         (select count(*)::int from messages m
           where m.thread_id = t.id and m.direction = 'out' and m.origin = 'app'
             and m.sent_at is null and m.rejected_at is null and m.failure_reason is null) as pending_replies,
         lm.direction::text as last_direction, lm.body as last_body, lm.sent_at as last_sent_at,
         d.completeness::text as discovery_completeness,
         b.id as brief_id, b.version as brief_version, b.locked as brief_locked
    from threads t
    left join jobs j on j.id = t.job_id
    left join lateral (
      select direction, body, sent_at from messages
       where thread_id = t.id
       order by coalesce(sent_at, created_at) desc, created_at desc limit 1
    ) lm on true
    left join lateral (
      select completeness from discovery_sessions
       where thread_id = t.id order by question_set_version desc, created_at desc limit 1
    ) d on true
    left join lateral (
      select id, version, locked from briefs where thread_id = t.id order by version desc limit 1
    ) b on true`;

const MESSAGES_SQL = `
  select m.id, m.direction::text as direction, m.origin, m.body, m.sent_at, m.approved_by,
         a.full_name as approved_by_name, m.approved_via::text as approved_via, m.rejected_at,
         m.failure_reason, m.external_message_id, m.created_at
    from messages m
    left join users a on a.id = m.approved_by
   where m.thread_id = $1
   order by coalesce(m.sent_at, m.created_at), m.created_at`;

/** An outbound app message's state is the approvals page's (ARB-122); anything else was received or observed. */
export type MessageState = OutboundMessageState | 'received' | 'observed';

export function describeThread(row: ThreadRow) {
  return {
    id: row.id,
    platform: row.platform,
    externalThreadId: row.external_thread_id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    clientHandle: row.client_handle,
    status: row.status,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    pendingReplies: row.pending_replies,
    lastMessage:
      row.last_body === null
        ? null
        : { direction: row.last_direction, body: row.last_body, sentAt: row.last_sent_at },
    discovery:
      row.discovery_completeness === null
        ? null
        : { completeness: Number(row.discovery_completeness) },
    brief:
      row.brief_id === null
        ? null
        : { id: row.brief_id, version: row.brief_version, locked: row.brief_locked },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function describeMessage(row: MessageRow) {
  const state: MessageState =
    row.direction === 'in'
      ? 'received'
      : row.origin === 'platform'
        ? 'observed'
        : outboundMessageState({
            sentAt: row.sent_at,
            approvedBy: row.approved_by,
            rejectedAt: row.rejected_at,
            failureReason: row.failure_reason,
          });
  return {
    id: row.id,
    direction: row.direction,
    origin: row.origin,
    body: row.body,
    state,
    sentAt: row.sent_at,
    approvedByName: row.approved_by_name,
    approvedVia: row.approved_via,
    rejectedAt: row.rejected_at,
    failureReason: row.failure_reason,
    externalMessageId: row.external_message_id,
    createdAt: row.created_at,
  };
}

async function loadThread(tx: Queryable, id: string): Promise<ThreadRow> {
  const { rows } = await tx.query<ThreadRow>(`${THREAD_SQL} where t.id = $1`, [id]);
  if (!rows[0]) throw refuse(404, 'no such thread');
  return rows[0];
}

export function registerThreadRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/threads', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const query = request.query as { status?: string; limit?: string; offset?: string };
    if (query.status !== undefined && !STATUSES.has(query.status)) {
      return reply.code(400).send({ error: `status must be one of ${[...STATUSES].join(', ')}` });
    }
    const limit = query.limit === undefined ? THREAD_PAGE_LIMIT : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_MAX_LIMIT) {
      return reply
        .code(400)
        .send({ error: `limit must be a whole number from 1 to ${String(THREAD_MAX_LIMIT)}` });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return reply.code(400).send({ error: 'offset must be a whole number of zero or more' });
    }
    const params: unknown[] = [limit, offset];
    if (query.status !== undefined) params.push(query.status);
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const { rows } = await tx.query<ThreadRow>(
        `${THREAD_SQL} ${query.status === undefined ? '' : 'where t.status = $3'}
         order by t.last_message_at desc nulls last, t.created_at desc, t.id limit $1 offset $2`,
        params,
      );
      return rows;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send({ threads: result.map(describeThread), page: { limit, offset } });
  });

  app.get('/v1/threads/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const thread = await loadThread(tx, id);
        const { rows } = await tx.query<MessageRow>(MESSAGES_SQL, [id]);
        return { thread, messages: rows };
      });
      return reply.send({
        thread: describeThread(result.thread),
        messages: result.messages.map(describeMessage),
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
