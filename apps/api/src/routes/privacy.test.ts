import { ERASED_TEXT } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/** ARB-521, the owner's audit P-04: data subject access and erasure over the API. */
let db: PGlite;
let app: FastifyInstance;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const OWNER_AUTH = fixtureId('a', ENTITY.authUser);
const OWNER = fixtureId('a', ENTITY.user);
const VIEWER = fixtureId('e', ENTITY.user);
const VIEWER_AUTH = fixtureId('e', ENTITY.authUser);
const OPERATOR = fixtureId('d', ENTITY.user);
const OPERATOR_AUTH = fixtureId('d', ENTITY.authUser);

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
  await db.exec(`insert into users (id, auth_user_id, email, full_name) values
    ('${VIEWER}', '${VIEWER_AUTH}', 'e@example.test', 'Viewer v'),
    ('${OPERATOR}', '${OPERATOR_AUTH}', 'd@example.test', 'Operator d')`);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${VIEWER}', 'viewer'), ('${ORG_A}', '${OPERATOR}', 'operator')`);
  await db.query(`update threads set client_handle = 'Acme_Ltd' where org_id = $1`, [ORG_A]);
  await db.query(`update threads set client_handle = 'acme_ltd' where org_id = $1`, [ORG_B]);

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = (request.headers as Record<string, unknown>)['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

async function events(type: string): Promise<{ actor_user_id: string; payload: unknown }[]> {
  const { rows } = await db.query<{ actor_user_id: string; payload: unknown }>(
    `select actor_user_id, payload from events where type = $1 order by created_at`,
    [type],
  );
  return rows;
}

describe('GET /v1/privacy/me', () => {
  it('downloads what is held about the person asking, and the audit log says so', async () => {
    const before = (await events('privacy.exported')).length;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/privacy/me',
      headers: as(VIEWER_AUTH),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="my-data-\d{8}\.json"$/,
    );
    const body = response.json() as {
      person: { id: string; email: string };
      memberships: { role: string }[];
    };
    expect(body.person).toMatchObject({ id: VIEWER, email: 'e@example.test' });
    expect(body.memberships.map((m) => m.role)).toEqual(['viewer']);
    // A viewer cannot write to the audit log, so the API records it in their name.
    const after = await events('privacy.exported');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ actor_user_id: VIEWER, payload: { kind: 'person' } });
  });

  it('turns away a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/privacy/me' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v1/privacy/clients/:handle', () => {
  it("gives an owner their org's conversations with that client, whatever the case", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/privacy/clients/ACME_LTD',
      headers: as(OWNER_AUTH),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/client-data-\d{8}\.json/);
    const body = response.json() as { threads: { id: string }[]; messages: { body: string }[] };
    expect(body.threads).toEqual([expect.objectContaining({ id: fixtureId('a', ENTITY.thread) })]);
    expect(body.messages.map((m) => m.body)).toEqual(['Hello']);
    const recorded = (await events('privacy.exported')).at(-1);
    expect(recorded).toEqual({
      actor_user_id: OWNER,
      payload: { kind: 'client', threads: 1, messages: 1 },
    });
  });

  it('is for owners only', async () => {
    for (const auth of [OPERATOR_AUTH, VIEWER_AUTH]) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/privacy/clients/acme_ltd',
        headers: as(auth),
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('refuses a handle no marketplace would give', async () => {
    const control = await app.inject({
      method: 'GET',
      url: '/v1/privacy/clients/acme%09ltd',
      headers: as(OWNER_AUTH),
    });
    expect(control.statusCode).toBe(422);
    // Past 100 characters Fastify itself refuses the path.
    const long = await app.inject({
      method: 'GET',
      url: `/v1/privacy/clients/${'x'.repeat(101)}`,
      headers: as(OWNER_AUTH),
    });
    expect(long.statusCode).toBe(414);
  });
});

describe('POST /v1/privacy/clients/:handle/erase', () => {
  it('asks for the handle again before erasing', async () => {
    for (const payload of [{}, { confirm: 'someone_else' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/privacy/clients/acme_ltd/erase',
        headers: as(OWNER_AUTH),
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
    const { rows } = await db.query(`select id from threads where client_handle is not null`);
    expect(rows).toHaveLength(2);
  });

  it('is for owners only', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/privacy/clients/acme_ltd/erase',
      headers: as(OPERATOR_AUTH),
      payload: { confirm: 'acme_ltd' },
    });
    expect(response.statusCode).toBe(403);
    const { rows } = await db.query(`select id from threads where redacted_at is not null`);
    expect(rows).toEqual([]);
  });

  it("erases the client's words in the owner's org only", async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/privacy/clients/acme_ltd/erase',
      headers: as(OWNER_AUTH),
      payload: { confirm: 'ACME_LTD' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ erased: { threads: 1, messages: 1, discoverySessions: 1 } });
    const { rows } = await db.query<{ org_id: string; client_handle: string | null; body: string }>(
      `select t.org_id, t.client_handle, m.body from threads t join messages m on m.thread_id = t.id
        order by t.org_id = $1 desc`,
      [ORG_A],
    );
    expect(rows).toEqual([
      { org_id: ORG_A, client_handle: null, body: ERASED_TEXT },
      { org_id: ORG_B, client_handle: 'acme_ltd', body: 'Hello' },
    ]);
    expect((await events('privacy.erased')).at(-1)).toEqual({
      actor_user_id: OWNER,
      payload: { threads: 1, messages: 1, discovery_sessions: 1 },
    });
  });
});
