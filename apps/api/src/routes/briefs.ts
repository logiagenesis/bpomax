import { briefFromDiscovery, briefLockBlockers, canWrite, validateBrief } from '@arbitron/core';
import {
  briefInputOf,
  insertBriefVersion,
  listBriefVersions,
  loadBrief,
  loadCurrentBrief,
  loadDiscoverySession,
  lockBrief,
  recordEvent,
  updateBrief,
  withUser,
  type BriefRow,
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
 * The brief (ARB-131, docs/01 section F): drafted from a thread's discovery answers,
 * edited while unlocked, locked once it carries what sourcing and pricing read, and
 * never edited after that: a change is a new version, and every version is kept. An
 * owner or operator writes; the conversations page (ARB-140) is where it is shown.
 */
export function describeBrief(row: BriefRow) {
  const input = briefInputOf(row);
  return {
    id: row.id,
    threadId: row.thread_id,
    version: row.version,
    locked: row.locked,
    lockedAt: row.locked_at,
    ...input,
    lockBlockers: row.locked ? [] : briefLockBlockers(input),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const versionOf = (row: BriefRow) => ({
  id: row.id,
  version: row.version,
  locked: row.locked,
  lockedAt: row.locked_at,
  updatedAt: row.updated_at,
});

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view briefs but not change them');
  return me;
}

async function visibleThread(
  tx: Queryable,
  id: string,
): Promise<{ id: string; job_title: string | null }> {
  const { rows } = await tx.query<{ id: string; job_title: string | null }>(
    `select t.id, j.title as job_title from threads t left join jobs j on j.id = t.job_id where t.id = $1`,
    [id],
  );
  if (!rows[0]) throw refuse(404, 'no such thread');
  return rows[0];
}

async function categoryExists(tx: Queryable, slug: string | null): Promise<boolean> {
  if (slug === null) return true;
  const { rows } = await tx.query('select 1 from service_categories where slug = $1', [slug]);
  return rows.length > 0;
}

export function registerBriefRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/threads/:id/brief', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        await visibleThread(tx, id);
        const versions = await listBriefVersions(tx, id);
        return { current: versions[0] ?? null, versions };
      });
      return reply.send({
        brief: result.current ? describeBrief(result.current) : null,
        versions: result.versions.map(versionOf),
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.get('/v1/briefs/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const row = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      return me ? loadBrief(tx, id) : null;
    });
    if (!row) return reply.code(404).send({ error: 'no such brief' });
    return reply.send({ brief: describeBrief(row) });
  });

  /** Version 1, from the discovery answers by hand (D-050); the model's draft is the worker's. */
  app.post('/v1/threads/:id/brief', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const thread = await visibleThread(tx, id);
        const me = await writer(tx);
        if (await loadCurrentBrief(tx, id))
          throw refuse(
            409,
            'This thread already has a brief. Edit it, or start a new version from the locked one.',
          );
        const session = await loadDiscoverySession(tx, id);
        const draft = briefFromDiscovery(session?.answers ?? {}, thread.job_title);
        const validated = validateBrief(draft);
        const brief = validated.ok
          ? validated.value
          : { ...draft, outcome: draft.outcome || '(not answered yet)' };
        const row = await insertBriefVersion(tx, { orgId: me.orgId, threadId: id, brief });
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'brief.drafted',
          actorUserId: me.userId,
          subjectTable: 'briefs',
          subjectId: row.id,
          requestId: request.id,
          payload: { via: 'web', version: row.version, from: session ? 'discovery' : 'empty' },
        });
        return row;
      });
      return reply.code(201).send({ brief: describeBrief(row) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.put('/v1/briefs/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateBrief(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const before = await loadBrief(tx, id);
        if (!before) throw refuse(404, 'no such brief');
        if (before.locked)
          throw refuse(
            409,
            `Version ${String(before.version)} is locked and cannot be changed. Start a new version to change it.`,
          );
        if (!(await categoryExists(tx, validated.value.category))) {
          throw Object.assign(refuse(422, 'the request was not accepted'), {
            errors: [{ field: 'category', message: 'is not a service category' }],
          });
        }
        const row = await updateBrief(tx, id, validated.value);
        if (!row) throw refuse(403, 'you do not have permission to change briefs in this org');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'brief.updated',
          actorUserId: me.userId,
          subjectTable: 'briefs',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            version: row.version,
            lock_blockers: briefLockBlockers(validated.value),
          },
        });
        return row;
      });
      return reply.send({ brief: describeBrief(row) });
    } catch (error) {
      const errors = (error as { errors?: unknown }).errors;
      return reply
        .code(statusOf(error))
        .send(errors ? { error: messageOf(error), errors } : { error: messageOf(error) });
    }
  });

  app.post('/v1/briefs/:id/lock', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const row = await loadBrief(tx, id);
        if (!row) throw refuse(404, 'no such brief');
        if (row.locked) throw refuse(409, `Version ${String(row.version)} is already locked.`);
        const outcome = await lockBrief(tx, row, now);
        if (!outcome.ok) return outcome;
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'brief.locked',
          actorUserId: me.userId,
          subjectTable: 'briefs',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            version: outcome.brief.version,
            category: outcome.brief.category_slug,
            delivery_route: outcome.brief.delivery_route,
          },
        });
        return outcome;
      });
      if (!result.ok) {
        return reply.code(422).send({
          error: `The brief cannot lock without ${result.missing.join(', ')}.`,
          errors: result.missing.map((what) => ({ field: 'lock', message: `needs ${what}` })),
        });
      }
      return reply.send({ brief: describeBrief(result.brief) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /** A new, unlocked version copied from this one; the old version is kept as it was. */
  app.post('/v1/briefs/:id/versions', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const from = await loadBrief(tx, id);
        if (!from) throw refuse(404, 'no such brief');
        const current = await loadCurrentBrief(tx, from.thread_id);
        if (current && !current.locked) {
          throw refuse(
            409,
            `Version ${String(current.version)} is still open. Edit it, or lock it before starting another.`,
          );
        }
        const row = await insertBriefVersion(tx, {
          orgId: me.orgId,
          threadId: from.thread_id,
          brief: briefInputOf(from),
        });
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'brief.drafted',
          actorUserId: me.userId,
          subjectTable: 'briefs',
          subjectId: row.id,
          requestId: request.id,
          payload: { via: 'web', version: row.version, from: `version ${String(from.version)}` },
        });
        return row;
      });
      return reply.code(201).send({ brief: describeBrief(row) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
