import {
  MANUAL_POST_PLATFORMS,
  SOURCING_POST_PLATFORMS,
  buildSourcingPost,
  canApprove,
  canWrite,
  clientIdentifyingProblems,
  validateSourcingPostEdit,
  type ClientIdentifiers,
  type SourcingPostPlatform,
} from '@arbitron/core';
import { briefInputOf, loadBrief, recordEvent, withUser, type Queryable } from '@arbitron/db';
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
 * Sourcing post drafts (ARB-202). A draft is written from the locked brief's scope by
 * `buildSourcingPost` and checked by `clientIdentifyingProblems` against the client's
 * handle, the sign-off name, the public job title and number; every edit is checked the
 * same way, and an edit clears an approval because the old one covered the old words
 * (the bids' rule, D-033). Approval names the person (0009's restrictive policy).
 *
 * Nothing here posts anything. Freelancer.com posts go through the API after approval
 * (ARB-203, with the live gate); Upwork and Fiverr posts are made by a person and
 * recorded here as posted.
 */
interface PostRow {
  readonly id: string;
  readonly sourcing_request_id: string;
  readonly platform: SourcingPostPlatform;
  readonly title: string;
  readonly body: string;
  readonly budget_min_minor: string | null;
  readonly budget_max_minor: string | null;
  readonly currency: string | null;
  readonly status: 'draft' | 'approved' | 'posted' | 'closed' | 'failed';
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_via: string | null;
  readonly external_id: string | null;
  readonly posted_at: string | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const POST_SQL = `
  select p.id, p.sourcing_request_id, p.platform::text as platform, p.title, p.body,
         p.budget_min_minor::text as budget_min_minor, p.budget_max_minor::text as budget_max_minor,
         p.currency::text as currency, p.status::text as status, p.approved_by,
         u.full_name as approved_by_name, p.approved_via::text as approved_via, p.external_id,
         p.posted_at, p.failure_reason, p.created_at, p.updated_at
    from sourcing_posts p
    left join users u on u.id = p.approved_by`;

export function describePost(row: PostRow) {
  return {
    id: row.id,
    sourcingRequestId: row.sourcing_request_id,
    platform: row.platform,
    manual: MANUAL_POST_PLATFORMS.includes(row.platform),
    title: row.title,
    body: row.body,
    budgetMinMinor: row.budget_min_minor,
    budgetMaxMinor: row.budget_max_minor,
    currency: row.currency?.trim() ?? null,
    status: row.status,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedVia: row.approved_via,
    externalId: row.external_id,
    postedAt: row.posted_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadPost(tx: Queryable, id: string): Promise<PostRow> {
  const { rows } = await tx.query<PostRow>(`${POST_SQL} where p.id = $1`, [id]);
  if (!rows[0]) throw refuse(404, 'no such sourcing post');
  return rows[0];
}

/** What would identify the client of the request's brief. */
async function identifiersFor(
  tx: Queryable,
  requestId: string,
): Promise<ClientIdentifiers & { briefId: string; status: string; categoryName: string | null }> {
  const { rows } = await tx.query<{
    brief_id: string;
    status: string;
    client_handle: string | null;
    sign_off_name: string | null;
    job_title: string | null;
    job_external_id: string | null;
    category_name: string | null;
  }>(
    `select r.brief_id, r.status::text as status, t.client_handle, b.sign_off_name,
            j.title as job_title, j.external_id as job_external_id, c.name as category_name
       from sourcing_requests r
       join briefs b on b.id = r.brief_id
       join threads t on t.id = b.thread_id
       left join jobs j on j.id = t.job_id
       left join service_categories c on c.slug = b.category_slug
      where r.id = $1`,
    [requestId],
  );
  const row = rows[0];
  if (!row) throw refuse(404, 'no such sourcing request');
  return {
    briefId: row.brief_id,
    status: row.status,
    categoryName: row.category_name,
    clientHandle: row.client_handle,
    signOffName: row.sign_off_name,
    jobTitle: row.job_title,
    jobExternalId: row.job_external_id,
  };
}

function identityRefusal(errors: readonly { field: string; message: string }[]): never {
  throw Object.assign(
    refuse(422, 'The post could identify the client. Take out what is named and save again.'),
    { errors },
  );
}

async function member(tx: Queryable, may: (role: Membership['role']) => boolean, verb: string) {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!may(me.role)) throw refuse(403, `your role can view sourcing posts but not ${verb} them`);
  return me;
}

function send(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) {
  const errors = (error as { errors?: unknown }).errors;
  return reply
    .code(statusOf(error))
    .send(errors ? { error: messageOf(error), errors } : { error: messageOf(error) });
}

/** The approvals page's filter (ARB-210): one status, or every post. */
const LIST_STATUSES = ['draft', 'approved', 'posted', 'failed', 'closed', 'all'] as const;

export function registerSourcingPostRoutes(app: FastifyInstance, options: ServerOptions): void {
  /**
   * Every sourcing post of the organisation in one status, newest first, with the brief it
   * was written from (ARB-210: the approvals page lists them beside bids and replies).
   */
  app.get('/v1/sourcing-posts', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const status = (request.query as { status?: string }).status ?? 'draft';
    if (!(LIST_STATUSES as readonly string[]).includes(status))
      return reply
        .code(422)
        .send(
          invalid([{ field: 'status', message: `must be one of ${LIST_STATUSES.join(', ')}` }]),
        );
    try {
      const posts = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const { rows } = await tx.query<PostRow & { brief_title: string }>(
          `select q.*, b.title as brief_title
             from (${POST_SQL} where ($1 = 'all' or p.status::text = $1)) q
             join sourcing_requests r on r.id = q.sourcing_request_id
             join briefs b on b.id = r.brief_id
            order by q.created_at desc, q.id
            limit 200`,
          [status],
        );
        return rows.map((row) => ({ ...describePost(row), briefTitle: row.brief_title }));
      });
      return reply.send({ posts });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get('/v1/sourcing-requests/:id/posts', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const rows = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        await identifiersFor(tx, id);
        const { rows } = await tx.query<PostRow>(
          `${POST_SQL} where p.sourcing_request_id = $1 order by p.created_at, p.id`,
          [id],
        );
        return rows;
      });
      return reply.send({ posts: rows.map(describePost) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** One draft per platform while it is live; the words are the brief's scope only. */
  app.post('/v1/sourcing-requests/:id/posts', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const platform = (request.body as { platform?: unknown } | null)?.platform;
    if (!SOURCING_POST_PLATFORMS.includes(platform as SourcingPostPlatform)) {
      return reply
        .code(422)
        .send(
          invalid([
            { field: 'platform', message: `must be one of ${SOURCING_POST_PLATFORMS.join(', ')}` },
          ]),
        );
    }
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await member(tx, canWrite, 'draft');
        const who = await identifiersFor(tx, id);
        if (!['open', 'shortlisting'].includes(who.status))
          throw refuse(409, `This request is ${who.status}, so no new post is drafted for it.`);
        const live = await tx.query(
          `select 1 from sourcing_posts where sourcing_request_id = $1 and platform = $2::platform
             and status in ('draft', 'approved', 'posted')`,
          [id, platform],
        );
        if (live.rows.length > 0)
          throw refuse(
            409,
            'This request already has a post for that platform. Edit it, or close it first.',
          );
        const brief = await loadBrief(tx, who.briefId);
        if (!brief) throw refuse(404, 'no such brief');
        const draft = buildSourcingPost(briefInputOf(brief), {
          categoryName: who.categoryName ?? brief.category_slug ?? 'Project',
        });
        const problems = clientIdentifyingProblems(draft, who);
        if (problems.length > 0) identityRefusal(problems);
        const { rows } = await tx.query<{ id: string }>(
          `insert into sourcing_posts (org_id, sourcing_request_id, platform, title, body)
           values ($1, $2, $3::platform, $4, $5) returning id`,
          [me.orgId, id, platform, draft.title, draft.body],
        );
        const postId = rows[0]?.id;
        if (!postId) throw refuse(403, 'you do not have permission to draft posts in this org');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.post_drafted',
          actorUserId: me.userId,
          subjectTable: 'sourcing_posts',
          subjectId: postId,
          requestId: request.id,
          payload: { via: 'web', sourcing_request_id: id, platform },
        });
        return loadPost(tx, postId);
      });
      return reply.code(201).send({ post: describePost(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** An edit is checked for the client's identity again, and clears an approval. */
  app.patch('/v1/sourcing-posts/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateSourcingPostEdit(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await member(tx, canWrite, 'edit');
        const before = await loadPost(tx, id);
        if (!['draft', 'approved'].includes(before.status))
          throw refuse(409, `This post is ${before.status}, so it cannot be changed.`);
        const who = await identifiersFor(tx, before.sourcing_request_id);
        const problems = clientIdentifyingProblems(validated.value, who);
        if (problems.length > 0) identityRefusal(problems);
        const v = validated.value;
        await tx.query(
          `update sourcing_posts set title = $2, body = $3, budget_min_minor = $4, budget_max_minor = $5,
                  currency = $6, status = 'draft', approved_by = null, approved_via = null
            where id = $1`,
          [id, v.title, v.body, v.budgetMinMinor, v.budgetMaxMinor, v.currency],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.post_edited',
          actorUserId: me.userId,
          subjectTable: 'sourcing_posts',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', cleared_approval: before.status === 'approved' },
        });
        return loadPost(tx, id);
      });
      return reply.send({ post: describePost(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/v1/sourcing-posts/:id/approve', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await member(tx, canApprove, 'approve');
        const before = await loadPost(tx, id);
        if (before.status !== 'draft')
          throw refuse(409, `This post is ${before.status}, so it cannot be approved.`);
        // A Freelancer.com project is created with a budget (ARB-203, D-055).
        if (
          before.platform === 'freelancer' &&
          (!before.currency ||
            (before.budget_min_minor === null && before.budget_max_minor === null))
        )
          throw refuse(
            409,
            'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
          );
        // The words are checked once more at the moment a person puts their name to them.
        const problems = clientIdentifyingProblems(
          before,
          await identifiersFor(tx, before.sourcing_request_id),
        );
        if (problems.length > 0) identityRefusal(problems);
        await tx.query(
          `update sourcing_posts set status = 'approved', approved_by = $2, approved_via = 'web' where id = $1`,
          [id, me.userId],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.post_approved',
          actorUserId: me.userId,
          subjectTable: 'sourcing_posts',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', platform: before.platform },
        });
        return loadPost(tx, id);
      });
      // A Freelancer.com post goes to the sender, which holds the live gate (D-032).
      let queued = false;
      if (row.platform === 'freelancer' && options.enqueue?.sourcingPost) {
        await options.enqueue.sourcingPost({ postId: id, requestId: request.id });
        queued = true;
      }
      return reply.send({ post: describePost(row), queued });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** Asks for the bids on a posted Freelancer.com project to be read now. */
  app.post('/v1/sourcing-posts/:id/collect', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        await member(tx, canWrite, 'collect bids for');
        return loadPost(tx, id);
      });
      if (row.platform !== 'freelancer' || row.status !== 'posted' || !row.external_id)
        return reply
          .code(409)
          .send({ error: 'Only a posted Freelancer.com project has bids to read.' });
      if (!options.enqueue?.sourcingCollect)
        return reply.code(503).send({
          error: 'The workers are not running here, so bids cannot be read now (docs/02 B-12).',
        });
      await options.enqueue.sourcingCollect({ postId: id, requestId: request.id });
      return reply.code(202).send({ queued: true });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** An Upwork or Fiverr post made by hand, recorded once it is approved. */
  app.post('/v1/sourcing-posts/:id/posted', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await member(tx, canWrite, 'record');
        const before = await loadPost(tx, id);
        if (!MANUAL_POST_PLATFORMS.includes(before.platform))
          throw refuse(
            409,
            'Freelancer.com posts are made through its API after approval, not recorded by hand.',
          );
        if (before.status !== 'approved')
          throw refuse(409, 'Only an approved post can be recorded as posted.');
        await tx.query(
          `update sourcing_posts set status = 'posted', posted_at = $2 where id = $1`,
          [id, now.toISOString()],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.posted',
          actorUserId: me.userId,
          subjectTable: 'sourcing_posts',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'manual', platform: before.platform },
        });
        return loadPost(tx, id);
      });
      return reply.send({ post: describePost(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/v1/sourcing-posts/:id/close', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await member(tx, canWrite, 'close');
        const before = await loadPost(tx, id);
        if (before.status === 'closed') throw refuse(409, 'This post is already closed.');
        await tx.query(`update sourcing_posts set status = 'closed' where id = $1`, [id]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.post_closed',
          actorUserId: me.userId,
          subjectTable: 'sourcing_posts',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', was: before.status },
        });
        return loadPost(tx, id);
      });
      return reply.send({ post: describePost(row) });
    } catch (error) {
      return send(reply, error);
    }
  });
}
