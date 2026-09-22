import { canWrite } from '@arbitron/core';
import { recordEvent, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, type Membership, type ServerOptions } from '../context.js';

/**
 * Who is signed in (ARB-061). Every page asks this once, to show the person's name and
 * org and to grey out what their role may not do (D-013: the greying is a courtesy; RLS
 * is the rule).
 */
export function describeMembership(me: Membership) {
  return {
    user: {
      id: me.userId,
      email: me.email,
      fullName: me.fullName,
      telegramLinked: me.telegramLinked,
    },
    org: { id: me.orgId, name: me.orgName, baseCurrency: me.baseCurrency },
    role: me.role,
  };
}

export function registerMeRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/me', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const me = await withUser(options.db, authUserId, currentMembership);
    if (!me) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send(describeMembership(me));
  });

  /**
   * The login page calls this once the identity provider has answered, so the audit log
   * records the sign-in (`auth.signed_in`). A viewer may not write events, and their
   * sign-in is not refused for it.
   */
  app.post('/v1/sessions', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const me = await withUser(options.db, authUserId, currentMembership);
    if (!me) return reply.code(403).send({ error: 'you are not a member of an organisation' });

    if (canWrite(me.role)) {
      await withUser(options.db, authUserId, (tx) =>
        recordEvent(tx, {
          orgId: me.orgId,
          type: 'auth.signed_in',
          actorUserId: me.userId,
          subjectTable: 'users',
          subjectId: me.userId,
          requestId: request.id,
          payload: { via: 'web' },
        }),
      );
    }
    return reply.code(201).send(describeMembership(me));
  });
}
