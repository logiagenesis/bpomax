import { listEvents } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/** ARB-130: the operator's side of discovery, against real Postgres with RLS on. */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
let db: PGlite;
let app: FastifyInstance;
let thread: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
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
    `insert into jobs (id, org_id, platform, external_id, raw, title) values ($1, $2, 'freelancer', '15791512', '{}'::jsonb, 'Shopify store rebuild')`,
    [JOB, ORG_A],
  );
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG_A, JOB],
  );
  thread = t.rows[0]!.id;
  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => new Date('2026-09-23T10:00:00Z'),
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('discovery on a thread', () => {
  it('is null until started; starting drafts the first three questions for approval and says so', async () => {
    const none = await app.inject({
      method: 'GET',
      url: `/v1/threads/${thread}/discovery`,
      headers: as(AUTH_A),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ session: null });

    const started = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/discovery`,
      headers: as(AUTH_A),
    });
    expect(started.statusCode).toBe(201);
    const body = started.json();
    expect(body.session).toMatchObject({
      threadId: thread,
      version: '1',
      completeness: 0,
      nextBatch: ['references', 'assets', 'tech'],
    });
    expect(body.session.questions).toHaveLength(10);
    expect(body.draft.keys).toEqual(['outcome', 'users', 'day_one']);
    expect(body.draft.body).toContain('Hi acme-shop');
    const drafted = await db.query<{ approved_by: string | null; sent_at: string | null }>(
      'select approved_by, sent_at from messages where id = $1',
      [body.draft.messageId],
    );
    expect(drafted.rows[0]).toEqual({ approved_by: null, sent_at: null });
    expect((await listEvents(db, { type: 'discovery.updated' }))[0]).toMatchObject({
      actor_user_id: USER_A,
    });
    expect((await listEvents(db, { type: 'message.drafted' }))[0]?.payload).toMatchObject({
      via: 'discovery',
      questions: ['outcome', 'users', 'day_one'],
    });

    const again = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/discovery`,
      headers: as(AUTH_A),
    });
    expect(again.statusCode).toBe(409);
  });

  it('answers captured by hand raise completeness; a bad key or empty answer is refused', async () => {
    const captured = await app.inject({
      method: 'PATCH',
      url: `/v1/threads/${thread}/discovery/answers`,
      headers: as(AUTH_A),
      payload: { answers: { outcome: 'An online shop', budget: ' R20 000, fixed ' } },
    });
    expect(captured.statusCode).toBe(200);
    // Hand-worked: 2 of 10 is 20 %.
    expect(captured.json().session).toMatchObject({ completeness: 20 });
    expect(
      captured.json().session.questions.find((q: { key: string }) => q.key === 'budget').answer,
    ).toMatchObject({
      answer: 'R20 000, fixed',
      source: 'operator',
    });
    expect((await listEvents(db, { type: 'discovery.updated' }))[0]?.payload).toMatchObject({
      captured: ['outcome', 'budget'],
      completeness: 20,
    });

    const refused = await app.inject({
      method: 'PATCH',
      url: `/v1/threads/${thread}/discovery/answers`,
      headers: as(AUTH_A),
      payload: { answers: { nope: 'x', users: '' } },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual([
      'answers.nope',
      'answers.users',
    ]);
  });

  it('the next batch skips answered questions and never asks everything; a viewer and another org cannot', async () => {
    const next = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/discovery/next`,
      headers: as(AUTH_A),
    });
    expect(next.statusCode).toBe(201);
    expect(next.json().draft.keys).toEqual(['references', 'assets', 'tech']);
    expect(next.json().session.nextBatch).toEqual(['deadline', 'acceptance', 'sign_off']);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/threads/${thread}/discovery/next`,
          headers: as(AUTH_VIEWER),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/threads/${thread}/discovery`,
          headers: as(AUTH_VIEWER),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/threads/${thread}/discovery`,
          headers: as(AUTH_B),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/threads/${thread}/discovery/answers`,
          headers: as(AUTH_B),
          payload: { answers: { outcome: 'x' } },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('with every question answered there is nothing left to ask', async () => {
    const rest = [
      'users',
      'day_one',
      'references',
      'assets',
      'tech',
      'deadline',
      'acceptance',
      'sign_off',
    ];
    const done = await app.inject({
      method: 'PATCH',
      url: `/v1/threads/${thread}/discovery/answers`,
      headers: as(AUTH_A),
      payload: { answers: Object.fromEntries(rest.map((key) => [key, 'x'])) },
    });
    expect(done.json().session).toMatchObject({ completeness: 100, nextBatch: [] });
    const next = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/discovery/next`,
      headers: as(AUTH_A),
    });
    expect(next.statusCode).toBe(409);
  });
});
