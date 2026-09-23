import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-340 acceptance: "Reply rate = replies/sends verified". Real Postgres with RLS on.
 * Each variant's figures are compared with a hand count and with a raw SQL count over
 * the base tables (proposals, threads, messages), not the view the route reads.
 *
 * Variant A: three bids sent. J1 and J2 had a client message after the bid went; J3's
 * only message came before it. 2 of 3 = 66,7 %.
 * Variant B: one bid sent (J4), no reply, and one still waiting for approval (J5), which
 * is not a send. 0 of 1 = 0,0 %.
 * The template: (2 + 0) of (3 + 1) = 2 of 4 = 50,0 %.
 * Org B sends from its own variant; none of it is counted here.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_B = fixtureId('b', ENTITY.user);
const USER_VIEWER = fixtureId('c', ENTITY.user);

let db: PGlite;
let app: FastifyInstance;
let template: string;
let variantA: string;
let variantB: string;
let unsent: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0]!;
}

async function sentBid(
  org: string,
  variant: string,
  title: string,
  { submitted = true, replied }: { submitted?: boolean; replied?: 'after' | 'before' } = {},
) {
  const job = await one<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title) values ($1, 'freelancer', $2, '{}'::jsonb, $2) returning id`,
    [org, title],
  );
  await db.query(
    `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status,
                            approved_by, approved_via, submitted_at, template_variant_id)
     values ($1, $2, 'Bid', 100000, 'ZAR', 5, $3::proposal_status, $4, 'web', $5, $6)`,
    [
      org,
      job.id,
      submitted ? 'submitted' : 'approved',
      org === ORG_A ? USER_A : USER_B,
      submitted ? '2026-09-10T08:00:00Z' : null,
      variant,
    ],
  );
  if (replied) {
    const thread = await one<{ id: string }>(
      `insert into threads (org_id, job_id, platform, external_thread_id) values ($1, $2, 'freelancer', $3) returning id`,
      [org, job.id, `t-${title}`],
    );
    await db.query(
      `insert into messages (org_id, thread_id, direction, body, sent_at, origin, external_message_id)
       values ($1, $2, 'in', 'Hello', $3, 'platform', $4)`,
      [
        org,
        thread.id,
        replied === 'after' ? '2026-09-11T08:00:00Z' : '2026-09-09T08:00:00Z',
        `m-${title}`,
      ],
    );
  }
}

async function variant(org: string, templateId: string, label: string) {
  return (
    await one<{ id: string }>(
      `insert into template_variants (org_id, template_id, label, body) values ($1, $2, $3, $4) returning id`,
      [org, templateId, label, `Words ${label}`],
    )
  ).id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${USER_B}', 'owner')`);
  await db.exec(
    `insert into users (id, auth_user_id, email) values ('${USER_VIEWER}', '${AUTH_VIEWER}', 'c@example.test')`,
  );
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${USER_VIEWER}', 'viewer')`,
  );
  template = (
    await one<{ id: string }>(
      `insert into templates (org_id, name, category_slug) values ($1, 'Web rebuild', 'web-design') returning id`,
      [ORG_A],
    )
  ).id;
  variantA = await variant(ORG_A, template, 'A');
  variantB = await variant(ORG_A, template, 'B');
  const general = (
    await one<{ id: string }>(
      `insert into templates (org_id, name) values ($1, 'General') returning id`,
      [ORG_A],
    )
  ).id;
  unsent = await variant(ORG_A, general, 'Only');
  await sentBid(ORG_A, variantA, 'J1', { replied: 'after' });
  await sentBid(ORG_A, variantA, 'J2', { replied: 'after' });
  await sentBid(ORG_A, variantA, 'J3', { replied: 'before' });
  await sentBid(ORG_A, variantB, 'J4');
  await sentBid(ORG_A, variantB, 'J5', { submitted: false, replied: 'after' });
  const templateB = (
    await one<{ id: string }>(
      `insert into templates (org_id, name) values ($1, 'Web rebuild') returning id`,
      [ORG_B],
    )
  ).id;
  const variantOfB = await variant(ORG_B, templateB, 'A');
  await sentBid(ORG_B, variantOfB, 'K1', { replied: 'after' });
  await sentBid(ORG_B, variantOfB, 'K2', { replied: 'after' });

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /v1/templates', () => {
  it('gives each variant’s sends, replies and rate, matching the hand count and raw SQL', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/templates', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    const { templates } = response.json();
    const web = templates.find((t: { id: string }) => t.id === template);
    expect(web).toMatchObject({
      name: 'Web rebuild',
      categorySlug: 'web-design',
      categoryName: 'Web design',
      sends: 4,
      replies: 2,
      replyRate: { numerator: 2, denominator: 4, percent: '50.0' },
    });
    expect(web.variants).toMatchObject([
      {
        id: variantA,
        label: 'A',
        sends: 3,
        replies: 2,
        replyRate: { percent: '66.7' },
        wordsLocked: expect.stringMatching(/^This variant has been sent 3 times/) as string,
      },
      { id: variantB, label: 'B', sends: 1, replies: 0, replyRate: { percent: '0.0' } },
    ]);
    const general = templates.find((t: { name: string }) => t.name === 'General');
    expect(general.variants[0]).toMatchObject({
      id: unsent,
      sends: 0,
      replies: 0,
      replyRate: { numerator: 0, denominator: 0, percent: null },
      wordsLocked: null,
    });

    // Raw SQL over the base tables, as the super user, org A only.
    const raw = await db.query<{ variant: string; sends: number; replies: number }>(
      `select p.template_variant_id as variant, count(*)::int as sends,
              count(*) filter (where exists (
                select 1 from messages m join threads t on t.id = m.thread_id
                 where t.job_id = p.job_id and m.direction = 'in'
                   and coalesce(m.sent_at, m.created_at) >= p.submitted_at))::int as replies
         from proposals p
        where p.org_id = $1 and p.status = 'submitted' and p.template_variant_id is not null
        group by p.template_variant_id`,
      [ORG_A],
    );
    const byVariant = new Map(raw.rows.map((r) => [r.variant, r]));
    for (const v of web.variants as { id: string; sends: number; replies: number }[]) {
      expect({ sends: v.sends, replies: v.replies }).toEqual({
        sends: byVariant.get(v.id)?.sends ?? 0,
        replies: byVariant.get(v.id)?.replies ?? 0,
      });
    }
  });

  it('shows a viewer the same, and another org only its own', async () => {
    const viewer = await app.inject({
      method: 'GET',
      url: '/v1/templates',
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.json().templates).toHaveLength(2);
    const other = await app.inject({ method: 'GET', url: '/v1/templates', headers: as(AUTH_B) });
    const theirs = other.json().templates;
    expect(theirs).toHaveLength(1);
    // Org B's own: 2 of 2; nothing of org A's bids.
    expect(theirs[0]).toMatchObject({ sends: 2, replies: 2, replyRate: { percent: '100.0' } });
  });
});

describe('changing templates', () => {
  it('creates a template, logged, and refuses a repeated name or an unknown category by field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      headers: as(AUTH_A),
      payload: { name: ' Shopify ', categorySlug: 'shopify', description: 'For shop builds' },
    });
    // The fixtures seed no shopify category.
    expect(created.statusCode).toBe(422);
    expect(created.json().errors).toEqual([
      { field: 'categorySlug', message: 'is not a service category' },
    ]);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      headers: as(AUTH_A),
      payload: { name: ' Landing pages ', categorySlug: 'web-design', description: '' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().template).toMatchObject({
      name: 'Landing pages',
      description: null,
      active: true,
      variants: [],
      replyRate: { percent: null },
    });
    const events = await listEvents(db, { type: 'template.created' });
    expect(events[0]).toMatchObject({
      actor_user_id: USER_A,
      subject_id: ok.json().template.id,
      payload: { via: 'web', name: 'Landing pages' },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      headers: as(AUTH_A),
      payload: { name: 'Landing pages' },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().errors).toEqual([
      { field: 'name', message: 'is already used by another template' },
    ]);
  });

  it('renames and switches off a template, logging what changed', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/templates/${template}`,
      headers: as(AUTH_A),
      payload: { name: 'Web rebuilds', active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().template).toMatchObject({ name: 'Web rebuilds', active: false });
    const events = await listEvents(db, { type: 'template.updated' });
    expect(events[0]?.payload).toEqual({
      via: 'web',
      changed: {
        name: { from: 'Web rebuild', to: 'Web rebuilds' },
        active: { from: true, to: false },
      },
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/templates/${template}`,
      headers: as(AUTH_A),
      payload: { active: true },
    });
  });

  it('adds a variant, and refuses a label already used in the template', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/templates/${template}/variants`,
      headers: as(AUTH_A),
      payload: { label: 'C', body: 'A shorter opening.' },
    });
    expect(response.statusCode).toBe(201);
    const c = response.json().template.variants.find((v: { label: string }) => v.label === 'C');
    expect(c).toMatchObject({ body: 'A shorter opening.', sends: 0, wordsLocked: null });
    expect((await listEvents(db, { type: 'template.variant_created' }))[0]?.payload).toEqual({
      via: 'web',
      template_id: template,
      label: 'C',
      bodyLength: 18,
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/templates/${template}/variants`,
      headers: as(AUTH_A),
      payload: { label: 'C', body: 'Other words.' },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().errors).toEqual([
      { field: 'label', message: 'is already used in this template' },
    ]);
  });

  it('locks the words of a variant that has been sent, but lets it be switched off', async () => {
    const locked = await app.inject({
      method: 'PATCH',
      url: `/v1/template-variants/${variantA}`,
      headers: as(AUTH_A),
      payload: { body: 'New words.' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toMatch(/^This variant has been sent 3 times, /);
    expect(
      (await one<{ body: string }>('select body from template_variants where id = $1', [variantA]))
        .body,
    ).toBe('Words A');
    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/template-variants/${variantA}`,
      headers: as(AUTH_A),
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);
    const a = off.json().template.variants.find((v: { id: string }) => v.id === variantA);
    expect(a).toMatchObject({ active: false, sends: 3 });
  });

  it('changes the words of a variant nothing has been sent from, logging lengths, not words', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/template-variants/${unsent}`,
      headers: as(AUTH_A),
      payload: { body: 'Better words.', label: 'First' },
    });
    expect(response.statusCode).toBe(200);
    expect((await listEvents(db, { type: 'template.variant_updated' }))[0]?.payload).toEqual({
      via: 'web',
      template_id: expect.any(String) as string,
      changed: { label: { from: 'Only', to: 'First' }, body: { from: 10, to: 13 } },
    });
  });

  it('refuses a viewer and another org, and an empty or bad change, touching nothing', async () => {
    const attempts = [
      { who: AUTH_VIEWER, url: `/v1/templates/${template}`, method: 'PATCH' as const, status: 403 },
      { who: AUTH_B, url: `/v1/templates/${template}`, method: 'PATCH' as const, status: 404 },
      {
        who: AUTH_B,
        url: `/v1/template-variants/${variantB}`,
        method: 'PATCH' as const,
        status: 404,
      },
      {
        who: AUTH_VIEWER,
        url: `/v1/templates/${template}/variants`,
        method: 'POST' as const,
        status: 403,
      },
    ];
    for (const a of attempts) {
      const response = await app.inject({
        method: a.method,
        url: a.url,
        headers: as(a.who),
        payload: { label: 'Z', body: 'Z', name: 'Z' },
      });
      expect(response.statusCode, `${a.method} ${a.url}`).toBe(a.status);
    }
    const empty = await app.inject({
      method: 'PATCH',
      url: `/v1/templates/${template}`,
      headers: as(AUTH_A),
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
    const bad = await app.inject({
      method: 'PATCH',
      url: '/v1/templates/nope',
      headers: as(AUTH_A),
      payload: { name: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await one<{ name: string }>('select name from templates where id = $1', [template])).name,
    ).toBe('Web rebuilds');
  });
});
