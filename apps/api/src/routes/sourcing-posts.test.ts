import { insertBriefVersion, listEvents, lockBrief } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-202 acceptance: "Drafts contain brief scope only, no client-identifying data".
 * Real Postgres with RLS on. The brief here carries the client's name, a link and the
 * sign-off person; the draft carries none of them, and an edit that adds one is refused.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let app: FastifyInstance;
let requestId: string;
let freelancerPost: string;
let upworkPost: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  await db.exec(
    `insert into users (id, auth_user_id, email) values ('${fixtureId('c', ENTITY.user)}', '${AUTH_VIEWER}', 'c@example.test')`,
  );
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${fixtureId('c', ENTITY.user)}', 'viewer')`,
  );
  await db.query(
    `insert into service_categories (slug, name, sort_order) values ('shopify', 'Shopify', 4) on conflict (slug) do nothing`,
  );
  await db.query(
    `insert into jobs (id, org_id, platform, external_id, raw, title) values ($1, $2, 'freelancer', '15791512', '{}'::jsonb, 'Shopify store rebuild for Acme')`,
    [JOB, ORG_A],
  );
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG_A, JOB],
  );
  const brief = await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: t.rows[0]!.id,
    brief: {
      title: 'Shopify store rebuild for Acme',
      outcome: 'An online shop that takes orders',
      users: 'Customers',
      mustHaves: ['Checkout'],
      later: [],
      references: ['https://acme-shop.co.za/old'],
      assetsProvided: [],
      assetsMissing: [],
      techConstraints: ['Shopify'],
      deadline: '2026-11-30',
      deadlineFixed: true,
      budget: { minMinor: 1500000, maxMinor: 2000000, currency: 'ZAR', type: 'fixed' },
      acceptanceCriteria: ['Orders go through'],
      signOff: { name: 'Thandi Mokoena', responseTime: 'same day' },
      risks: [],
      category: 'shopify',
      deliveryRoute: 'supplier',
    },
  });
  const locked = await lockBrief(db, brief, NOW);
  if (!locked.ok) throw new Error('fixture brief should lock');
  const r = await db.query<{ id: string }>(
    `insert into sourcing_requests (org_id, brief_id) values ($1, $2) returning id`,
    [ORG_A, locked.brief.id],
  );
  requestId = r.rows[0]!.id;
  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => NOW,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('drafting', () => {
  it('writes the scope only: no handle, sign-off, job title or number, link, or the client’s budget', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_A),
      payload: { platform: 'freelancer' },
    });
    expect(response.statusCode).toBe(201);
    const { post } = response.json();
    freelancerPost = post.id;
    expect(post).toMatchObject({
      platform: 'freelancer',
      manual: false,
      status: 'draft',
      title: 'Shopify: An online shop that takes orders',
      budgetMinMinor: null,
      budgetMaxMinor: null,
      currency: null,
      approvedBy: null,
    });
    const text = `${post.title}\n${post.body}`.toLowerCase();
    for (const secret of [
      'acme',
      'thandi',
      'mokoena',
      '15791512',
      'http',
      'shopify store rebuild',
      '15 000',
      '20 000',
      'r15',
      'r20',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(post.body).toContain('Deadline: 30/11/2026 (fixed)');
    expect(post.body).toContain('Reference examples: 1, shared with the supplier chosen.');
    expect((await listEvents(db, { type: 'sourcing.post_drafted' }))[0]?.payload).toMatchObject({
      platform: 'freelancer',
    });
  });

  it('keeps one live draft per platform, refuses an unknown platform and a viewer', async () => {
    const again = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_A),
      payload: { platform: 'freelancer' },
    });
    expect(again.statusCode).toBe(409);
    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_A),
      payload: { platform: 'craigslist' },
    });
    expect(unknown.statusCode).toBe(422);
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_VIEWER),
      payload: { platform: 'upwork' },
    });
    expect(viewer.statusCode).toBe(403);
    const upwork = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_A),
      payload: { platform: 'upwork' },
    });
    expect(upwork.statusCode).toBe(201);
    upworkPost = upwork.json().post.id;
    expect(upwork.json().post.manual).toBe(true);
  });
});

describe('editing and approving', () => {
  it('refuses an edit that names the client, with each problem on its field, and changes nothing', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-posts/${freelancerPost}`,
      headers: as(AUTH_A),
      payload: {
        title: 'Rebuild for acme-shop',
        body: 'Call Thandi Mokoena on 012 345 6789 or see acme-shop.co.za',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe(
      'The post could identify the client. Take out what is named and save again.',
    );
    expect(response.json().errors).toEqual([
      { field: 'title', message: 'contains the client’s handle' },
      { field: 'body', message: 'contains the client’s handle' },
      { field: 'body', message: 'contains the name of the client’s sign-off person' },
      { field: 'body', message: 'contains a phone number' },
      { field: 'body', message: 'contains a web address' },
    ]);
    const stored = await db.query<{ title: string }>(
      'select title from sourcing_posts where id = $1',
      [freelancerPost],
    );
    expect(stored.rows[0]?.title).toBe('Shopify: An online shop that takes orders');
  });

  it('a Freelancer.com post needs a budget before approval; then it is approved in the approver’s own name, and an edit clears it', async () => {
    const early = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/approve`,
      headers: as(AUTH_A),
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe(
      'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
    );
    // Hand-worked: R8 000,00 to R12 000,00 is 800 000 to 1 200 000 cents.
    const budgeted = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-posts/${freelancerPost}`,
      headers: as(AUTH_A),
      payload: {
        title: 'Shopify shop build',
        body: 'An online shop that takes orders. Next.js front end welcome.',
        budgetMinMinor: 800000,
        budgetMaxMinor: 1200000,
        currency: 'ZAR',
      },
    });
    expect(budgeted.statusCode).toBe(200);
    expect(budgeted.json().post).toMatchObject({
      budgetMinMinor: '800000',
      budgetMaxMinor: '1200000',
      currency: 'ZAR',
    });
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/approve`,
      headers: as(AUTH_A),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      post: { status: 'approved', approvedBy: USER_A, approvedVia: 'web' },
      // No queue in this server: the post waits, approved, for the sender.
      queued: false,
    });
    const twice = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/approve`,
      headers: as(AUTH_A),
    });
    expect(twice.statusCode).toBe(409);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-posts/${freelancerPost}`,
      headers: as(AUTH_A),
      payload: {
        title: 'Shopify shop build',
        body: 'An online shop that takes orders.',
        budgetMinMinor: 800000,
        budgetMaxMinor: 1200000,
        currency: 'ZAR',
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().post).toMatchObject({ status: 'draft', approvedBy: null });
    expect((await listEvents(db, { type: 'sourcing.post_edited' }))[0]?.payload).toMatchObject({
      cleared_approval: true,
    });
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/approve`,
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('with the queues wired, approval hands a Freelancer.com post to the sender, and Collect asks for its bids', async () => {
    const posts: unknown[] = [];
    const collects: unknown[] = [];
    const wired = buildServer({
      db,
      authenticate: (request) => {
        const header = request.headers['x-test-auth-user'];
        return typeof header === 'string' ? header : null;
      },
      now: () => NOW,
      enqueue: {
        sourcingPost: async (data) => void posts.push(data),
        sourcingCollect: async (data) => void collects.push(data),
      },
    });
    await wired.ready();
    try {
      const approved = await wired.inject({
        method: 'POST',
        url: `/v1/sourcing-posts/${freelancerPost}/approve`,
        headers: as(AUTH_A),
      });
      expect(approved.json()).toMatchObject({ queued: true });
      expect(posts).toEqual([{ postId: freelancerPost, requestId: expect.any(String) }]);
      const notYet = await wired.inject({
        method: 'POST',
        url: `/v1/sourcing-posts/${freelancerPost}/collect`,
        headers: as(AUTH_A),
      });
      expect(notYet.statusCode).toBe(409);
      // What the sender writes once the project exists (tested in apps/workers).
      await db.query(
        `update sourcing_posts set status = 'posted', external_id = '16000001', posted_at = now() where id = $1`,
        [freelancerPost],
      );
      const collect = await wired.inject({
        method: 'POST',
        url: `/v1/sourcing-posts/${freelancerPost}/collect`,
        headers: as(AUTH_A),
      });
      expect(collect.statusCode).toBe(202);
      expect(collects).toEqual([{ postId: freelancerPost, requestId: expect.any(String) }]);
      const unwired = await app.inject({
        method: 'POST',
        url: `/v1/sourcing-posts/${freelancerPost}/collect`,
        headers: as(AUTH_A),
      });
      expect(unwired.statusCode).toBe(503);
    } finally {
      await wired.close();
    }
  });

  it('records a manual post as posted only once approved; a Freelancer.com post is never recorded by hand', async () => {
    const early = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${upworkPost}/posted`,
      headers: as(AUTH_A),
    });
    expect(early.statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${upworkPost}/approve`,
      headers: as(AUTH_A),
    });
    const posted = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${upworkPost}/posted`,
      headers: as(AUTH_A),
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().post).toMatchObject({
      status: 'posted',
      postedAt: expect.stringContaining('2026-09-23'),
    });
    const locked = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-posts/${upworkPost}`,
      headers: as(AUTH_A),
      payload: { title: 'T', body: 'B' },
    });
    expect(locked.statusCode).toBe(409);
    const freelancer = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/posted`,
      headers: as(AUTH_A),
    });
    expect(freelancer.statusCode).toBe(409);
    expect(freelancer.json().error).toBe(
      'Freelancer.com posts are made through its API after approval, not recorded by hand.',
    );
  });

  it('closes a post, after which a new draft for that platform may be made', async () => {
    const closed = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-posts/${freelancerPost}/close`,
      headers: as(AUTH_A),
    });
    expect(closed.json().post.status).toBe('closed');
    const again = await app.inject({
      method: 'POST',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_A),
      payload: { platform: 'freelancer' },
    });
    expect(again.statusCode).toBe(201);
  });

  it('lists the request’s posts to its organisation only', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_VIEWER),
    });
    expect(
      list.json().posts.map((p: { platform: string; status: string }) => [p.platform, p.status]),
    ).toEqual([
      ['freelancer', 'closed'],
      ['upwork', 'posted'],
      ['freelancer', 'draft'],
    ]);
    const other = await app.inject({
      method: 'GET',
      url: `/v1/sourcing-requests/${requestId}/posts`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
  });
});
