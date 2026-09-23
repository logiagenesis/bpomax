import { listEvents } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/** ARB-121: the org's auto-reply, set from Settings, with its approver recorded. */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_OPERATOR = fixtureId('d', ENTITY.user);
let db: PGlite;
let app: FastifyInstance;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(
      `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`,
    );
  }
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

describe('the auto-reply', () => {
  it('is null until set, then saved with the person who approved it, and read back', async () => {
    const empty = await app.inject({ method: 'GET', url: '/v1/auto-reply', headers: as(AUTH_A) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ autoReply: null });

    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/auto-reply',
      headers: as(AUTH_A),
      payload: {
        body: ' Thanks, I will reply within a day. ',
        active: true,
        offlineAfterMinutes: '45',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().autoReply).toMatchObject({
      body: 'Thanks, I will reply within a day.',
      active: true,
      offlineAfterMinutes: 45,
      approvedBy: USER_A,
    });
    const read = await app.inject({ method: 'GET', url: '/v1/auto-reply', headers: as(AUTH_A) });
    expect(read.json().autoReply).toMatchObject({ active: true, offlineAfterMinutes: 45 });

    const events = await listEvents(db, { type: 'settings.changed' });
    expect(events[0]).toMatchObject({
      org_id: ORG_A,
      actor_user_id: USER_A,
      subject_table: 'auto_replies',
    });
    expect(events[0]?.payload).toMatchObject({ changed: ['autoReply'], before: null });
  });

  it('a second save updates the same row; the operator may save it and becomes its approver', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/auto-reply',
      headers: as(AUTH_OPERATOR),
      payload: { body: 'Back soon.', active: false, offlineAfterMinutes: 30 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().autoReply).toMatchObject({
      body: 'Back soon.',
      active: false,
      approvedBy: USER_OPERATOR,
    });
    const rows = await db.query<{ n: number }>(
      'select count(*)::int as n from auto_replies where org_id = $1',
      [ORG_A],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('refuses an empty wording while on, with the field named', async () => {
    const refused = await app.inject({
      method: 'PUT',
      url: '/v1/auto-reply',
      headers: as(AUTH_A),
      payload: { body: '', active: true, offlineAfterMinutes: 30 },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors).toEqual([
      { field: 'body', message: 'must not be empty while the auto-reply is on' },
    ]);
  });

  it('a viewer can read it and not change it; another org sees its own, which is none', async () => {
    const read = await app.inject({
      method: 'GET',
      url: '/v1/auto-reply',
      headers: as(AUTH_VIEWER),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().autoReply).toMatchObject({ body: 'Back soon.' });
    const refused = await app.inject({
      method: 'PUT',
      url: '/v1/auto-reply',
      headers: as(AUTH_VIEWER),
      payload: { body: 'Hi', active: true },
    });
    expect(refused.statusCode).toBe(403);
    const other = await app.inject({ method: 'GET', url: '/v1/auto-reply', headers: as(AUTH_B) });
    expect(other.json()).toEqual({ autoReply: null });
    const anonymous = await app.inject({ method: 'GET', url: '/v1/auto-reply' });
    expect(anonymous.statusCode).toBe(401);
  });
});
