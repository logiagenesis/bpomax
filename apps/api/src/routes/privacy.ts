import {
  eraseClient,
  exportClient,
  exportPerson,
  inTransaction,
  recordEvent,
  withUser,
} from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * ARB-521, the owner's audit P-04: data subject access and erasure (D-080).
 *
 * - `GET /v1/privacy/me`: anyone signed in downloads what is held about them, read as
 *   them, so row-level security keeps it to their own rows in their own organisations.
 * - `GET /v1/privacy/clients/:handle`: an owner downloads what their organisation holds
 *   about a marketplace client, by the client's handle.
 * - `POST /v1/privacy/clients/:handle/erase`: an owner erases that client's conversations
 *   in their organisation. It cannot be undone, so the handle is typed again as `confirm`.
 *
 * Answering a request is the owner's duty as the responsible party; these give them the
 * means. The audit log records that it was done, with counts and never the handle
 * (D-076). Deleting a person or an organisation is D-17, not built.
 */
const MAX_HANDLE = 100;

function parseHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const handle = raw.trim();
  if (handle.length === 0 || handle.length > MAX_HANDLE) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(handle)) return null;
  return handle;
}

const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

export function registerPrivacyRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/privacy/me', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const found = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('select app.current_user_id() as id');
      const userId = rows[0]?.id;
      if (!userId) return null;
      const me = await currentMembership(tx);
      return { userId, orgId: me?.orgId ?? null, data: await exportPerson(tx, userId) };
    });
    if (!found) return reply.code(403).send({ error: 'there is no account for this sign-in' });

    // A viewer may not append to the audit log themselves, so the record of their
    // request is written by the API, in their name.
    if (found.orgId) {
      await recordEvent(options.db, {
        orgId: found.orgId,
        type: 'privacy.exported',
        actorUserId: found.userId,
        subjectTable: 'users',
        subjectId: found.userId,
        requestId: request.id,
        payload: {
          kind: 'person',
          rows: Object.values(found.data.namedIn).reduce((n, rows) => n + rows.length, 0),
        },
      });
    }

    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="my-data-${stamp()}.json"`)
      .send(JSON.stringify({ generatedAt: new Date().toISOString(), ...found.data }, null, 2));
  });

  app.get('/v1/privacy/clients/:handle', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const handle = parseHandle((request.params as { handle?: unknown }).handle);
    if (!handle) {
      return reply
        .code(422)
        .send(invalid([{ field: 'handle', message: `must be 1 to ${MAX_HANDLE} characters` }]));
    }

    try {
      const data = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (me.role !== 'owner') {
          throw refuse(403, "Only an owner can answer a client's request for their data.");
        }
        const data = await exportClient(tx, me.orgId, handle);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'privacy.exported',
          actorUserId: me.userId,
          requestId: request.id,
          // Counts only: the handle is the client's.
          payload: {
            kind: 'client',
            threads: data.threads.length,
            messages: data.messages.length,
          },
        });
        return data;
      });
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="client-data-${stamp()}.json"`)
        .send(JSON.stringify({ generatedAt: new Date().toISOString(), ...data }, null, 2));
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/privacy/clients/:handle/erase', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const handle = parseHandle((request.params as { handle?: unknown }).handle);
    if (!handle) {
      return reply
        .code(422)
        .send(invalid([{ field: 'handle', message: `must be 1 to ${MAX_HANDLE} characters` }]));
    }
    const confirm = parseHandle((request.body as { confirm?: unknown } | null)?.confirm);
    if (!confirm || confirm.toLowerCase() !== handle.toLowerCase()) {
      return reply.code(422).send(
        invalid([
          {
            field: 'confirm',
            message: "must be the client's handle again: erasure cannot be undone",
          },
        ]),
      );
    }

    try {
      const me = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (me.role !== 'owner') throw refuse(403, "Only an owner can erase a client's data.");
        return me;
      });
      // The redaction columns are not the signed-in person's to write (0038); the API
      // writes them, as the retention job does, once the owner is established above.
      const erased = await inTransaction(options.db, (tx) =>
        eraseClient(tx, {
          orgId: me.orgId,
          handle,
          actorUserId: me.userId,
          requestId: request.id,
        }),
      );
      return reply.send({ erased });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
