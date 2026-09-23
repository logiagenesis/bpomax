import {
  DISCOVERY_QUESTIONS,
  canWrite,
  nextDiscoveryBatch,
  validateDiscoveryAnswers,
} from '@arbitron/core';
import {
  captureDiscoveryAnswers,
  draftDiscoveryBatch,
  loadDiscoverySession,
  recordEvent,
  startDiscoverySession,
  withUser,
  type DiscoverySessionRow,
  type Queryable,
} from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  currentMembership,
  invalid,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Discovery sessions (ARB-130, docs/01 section F). The operator starts a session on a
 * thread, which drafts the first batch of questions as an outbound message for
 * approval (ARB-122); captures answers by hand when the client gave them in a call or
 * a message the model did not read; and asks for the next batch. The worker does the
 * same on each client reply. The conversations page (ARB-140) is where this is shown.
 */
export function describeSession(session: DiscoverySessionRow) {
  return {
    id: session.id,
    threadId: session.thread_id,
    version: session.question_set_version,
    completeness: Number(session.completeness),
    answers: session.answers,
    asked: session.asked,
    questions: DISCOVERY_QUESTIONS.map((question) => ({
      key: question.key,
      text: question.text,
      answer: session.answers[question.key] ?? null,
      askedAt: session.asked[question.key] ?? null,
    })),
    nextBatch: nextDiscoveryBatch(session.answers, session.asked).map((q) => q.key),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

interface ThreadRow {
  id: string;
  org_id: string;
  client_handle: string | null;
}

async function visibleThread(tx: Queryable, id: string): Promise<ThreadRow> {
  const { rows } = await tx.query<ThreadRow>(
    'select id, org_id, client_handle from threads where id = $1',
    [id],
  );
  if (!rows[0]) throw refuse(404, 'no such thread');
  return rows[0];
}

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view discovery but not change it');
  return me;
}

export function registerDiscoveryRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/threads/:id/discovery', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const session = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        await visibleThread(tx, id);
        return loadDiscoverySession(tx, id);
      });
      return reply.send({ session: session ? describeSession(session) : null });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/threads/:id/discovery', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const thread = await visibleThread(tx, id);
        const me = await writer(tx);
        if (await loadDiscoverySession(tx, id))
          throw refuse(409, 'Discovery has already started on this thread.');
        const session = await startDiscoverySession(tx, { orgId: me.orgId, threadId: id });
        const draft = await draftDiscoveryBatch(tx, session, {
          clientHandle: thread.client_handle,
          now,
        });
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'discovery.updated',
          actorUserId: me.userId,
          subjectTable: 'discovery_sessions',
          subjectId: session.id,
          requestId: request.id,
          payload: {
            via: 'web',
            started: true,
            drafted: draft?.keys ?? [],
            drafted_message_id: draft?.messageId ?? null,
          },
        });
        if (draft) {
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'message.drafted',
            actorUserId: me.userId,
            subjectTable: 'messages',
            subjectId: draft.messageId,
            requestId: request.id,
            payload: { via: 'discovery', thread_id: id, questions: draft.keys },
          });
        }
        return { session: draft?.session ?? session, draft };
      });
      return reply.code(201).send({
        session: describeSession(result.session),
        draft: result.draft
          ? { messageId: result.draft.messageId, keys: result.draft.keys, body: result.draft.body }
          : null,
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.patch('/v1/threads/:id/discovery/answers', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateDiscoveryAnswers(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const now = options.now ? options.now() : new Date();
    try {
      const session = await withUser(options.db, authUserId, async (tx) => {
        await visibleThread(tx, id);
        const me = await writer(tx);
        const existing = await loadDiscoverySession(tx, id);
        if (!existing) throw refuse(404, 'Discovery has not started on this thread.');
        const { session, captured } = await captureDiscoveryAnswers(
          tx,
          existing,
          validated.value,
          'operator',
          now,
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'discovery.updated',
          actorUserId: me.userId,
          subjectTable: 'discovery_sessions',
          subjectId: session.id,
          requestId: request.id,
          payload: {
            via: 'web',
            captured,
            replaced: Object.keys(validated.value).filter((key) => !captured.includes(key)),
            completeness: Number(session.completeness),
          },
        });
        return session;
      });
      return reply.send({ session: describeSession(session) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/threads/:id/discovery/next', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const thread = await visibleThread(tx, id);
        const me = await writer(tx);
        const existing = await loadDiscoverySession(tx, id);
        if (!existing) throw refuse(404, 'Discovery has not started on this thread.');
        const draft = await draftDiscoveryBatch(tx, existing, {
          clientHandle: thread.client_handle,
          now,
        });
        if (!draft)
          throw refuse(409, 'Every question has been answered; there is nothing left to ask.');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'message.drafted',
          actorUserId: me.userId,
          subjectTable: 'messages',
          subjectId: draft.messageId,
          requestId: request.id,
          payload: { via: 'discovery', thread_id: id, questions: draft.keys },
        });
        return draft;
      });
      return reply.code(201).send({
        session: describeSession(result.session),
        draft: { messageId: result.messageId, keys: result.keys, body: result.body },
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
