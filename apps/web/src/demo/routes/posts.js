// @ts-check
/** The demo's posts routes (D-043), split out of demo.js (ARB-531). */
import {
  buildSourcingPost,
  clientIdentifyingProblems,
  validateSourcingPostEdit,
} from '@arbitron/core';
import { categoryName, logEvent } from '../shared.js';
import { USER, uuid } from '../store.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function postRoutes(ctx) {
  const {
    method,
    url,
    body,
    store,
    path,
    key,
    idIn,
    respond,
    sourcing,
    posts,
    whoFor,
    postIn,
    describePost,
    identityRefused,
  } = ctx;
  // ARB-202 in the demo: sourcing post drafts, checked by the same rules as the API.
  // ARB-210: every post of the org by status, for the approvals page.
  if (key === 'GET /v1/sourcing-posts') {
    const wanted = url.searchParams.get('status') ?? 'draft';
    if (!['draft', 'approved', 'posted', 'failed', 'closed', 'all'].includes(wanted)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [
          {
            field: 'status',
            message: 'must be one of draft, approved, posted, failed, closed, all',
          },
        ],
      });
    }
    return respond(200, {
      posts: posts
        .filter((row) => wanted === 'all' || row.status === wanted)
        .map((row) => ({
          ...describePost(row),
          briefTitle:
            sourcing.find((r) => r.id === row.sourcingRequestId)?.briefTitle ?? 'Unknown brief',
        })),
    });
  }
  if (method === 'GET' && /^\/v1\/sourcing-requests\/[^/]+\/posts$/.test(path)) {
    const id = idIn('/v1/sourcing-requests/');
    return respond(200, {
      posts: posts.filter((row) => row.sourcingRequestId === id).map(describePost),
    });
  }
  if (method === 'POST' && /^\/v1\/sourcing-requests\/[^/]+\/posts$/.test(path)) {
    const request = sourcing.find((row) => row.id === idIn('/v1/sourcing-requests/'));
    if (!request) return respond(404, { error: 'no such sourcing request' });
    const platform = body?.platform;
    if (!['freelancer', 'upwork', 'fiverr'].includes(platform)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'platform', message: 'must be one of freelancer, upwork, fiverr' }],
      });
    }
    if (!['open', 'shortlisting'].includes(request.status))
      return respond(409, {
        error: `This request is ${request.status}, so no new post is drafted for it.`,
      });
    if (
      posts.some(
        (row) =>
          row.sourcingRequestId === request.id &&
          row.platform === platform &&
          ['draft', 'approved', 'posted'].includes(row.status),
      )
    ) {
      return respond(409, {
        error: 'This request already has a post for that platform. Edit it, or close it first.',
      });
    }
    const { brief: b, who } = whoFor(request);
    if (!b) return respond(404, { error: 'no such brief' });
    const draft = buildSourcingPost(/** @type {any} */ (b), {
      categoryName: categoryName(b.category ?? 'project'),
    });
    const problems = clientIdentifyingProblems(draft, who);
    if (problems.length > 0) return identityRefused(problems);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      sourcingRequestId: request.id,
      platform,
      title: draft.title,
      body: draft.body,
      budgetMinMinor: null,
      budgetMaxMinor: null,
      currency: null,
      status: 'draft',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      externalId: null,
      postedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    posts.push(row);
    store.posts = posts;
    logEvent(store, 'sourcing.post_drafted', {
      subject_table: 'sourcing_posts',
      subject_id: row.id,
      payload: { via: 'web', sourcing_request_id: request.id, platform },
    });
    return respond(201, { post: describePost(row) });
  }
  if (method === 'PATCH' && /^\/v1\/sourcing-posts\/[^/]+$/.test(path)) {
    const row = postIn('/v1/sourcing-posts/');
    if (!row) return respond(404, { error: 'no such sourcing post' });
    const validated = validateSourcingPostEdit(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    if (!['draft', 'approved'].includes(row.status))
      return respond(409, { error: `This post is ${row.status}, so it cannot be changed.` });
    const request = sourcing.find((r) => r.id === row.sourcingRequestId);
    const problems = request ? clientIdentifyingProblems(validated.value, whoFor(request).who) : [];
    if (problems.length > 0) return identityRefused(problems);
    const cleared = row.status === 'approved';
    const v = validated.value;
    Object.assign(row, {
      title: v.title,
      body: v.body,
      budgetMinMinor: v.budgetMinMinor === null ? null : String(v.budgetMinMinor),
      budgetMaxMinor: v.budgetMaxMinor === null ? null : String(v.budgetMaxMinor),
      currency: v.currency,
      status: 'draft',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      updatedAt: new Date().toISOString(),
    });
    logEvent(store, 'sourcing.post_edited', {
      subject_table: 'sourcing_posts',
      subject_id: row.id,
      payload: { via: 'web', cleared_approval: cleared },
    });
    return respond(200, { post: describePost(row) });
  }
  if (method === 'POST' && /^\/v1\/sourcing-posts\/[^/]+\/(approve|posted|close)$/.test(path)) {
    const row = postIn('/v1/sourcing-posts/');
    if (!row) return respond(404, { error: 'no such sourcing post' });
    const action = path.split('/').pop();
    const now = new Date().toISOString();
    if (action === 'approve') {
      if (row.status !== 'draft')
        return respond(409, { error: `This post is ${row.status}, so it cannot be approved.` });
      if (
        row.platform === 'freelancer' &&
        (!row.currency || (row.budgetMinMinor === null && row.budgetMaxMinor === null))
      ) {
        return respond(409, {
          error: 'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
        });
      }
      if (row.platform === 'freelancer') {
        // Live mode is off in the demo: the sender records what it would have posted.
        logEvent(store, 'external.blocked_by_live_mode', {
          actor_kind: 'system',
          actor_user_id: null,
          outcome: 'blocked',
          subject_table: 'sourcing_posts',
          subject_id: row.id,
          payload: { wouldSend: { call: 'projects/0.1/projects', title: row.title } },
        });
      }
      Object.assign(row, {
        status: 'approved',
        approvedBy: USER,
        approvedByName: 'Demo Owner',
        approvedVia: 'web',
      });
      logEvent(store, 'sourcing.post_approved', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'web', platform: row.platform },
      });
    } else if (action === 'posted') {
      if (row.platform === 'freelancer') {
        return respond(409, {
          error:
            'Freelancer.com posts are made through its API after approval, not recorded by hand.',
        });
      }
      if (row.status !== 'approved')
        return respond(409, { error: 'Only an approved post can be recorded as posted.' });
      Object.assign(row, { status: 'posted', postedAt: now });
      logEvent(store, 'sourcing.posted', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'manual', platform: row.platform },
      });
    } else {
      if (row.status === 'closed') return respond(409, { error: 'This post is already closed.' });
      const was = row.status;
      row.status = 'closed';
      logEvent(store, 'sourcing.post_closed', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'web', was },
      });
    }
    row.updatedAt = now;
    return respond(200, { post: describePost(row) });
  }
  return undefined;
}
