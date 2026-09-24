import { listEvents, readPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { upworkConfig } from '@arbitron/upwork';
import { createFakeUpwork } from '@arbitron/upwork/fake';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-300: connecting an Upwork account for the read-only job search, against real
 * Postgres with RLS on and the Upwork stand-in (`@arbitron/upwork/fake`), which answers
 * in the documented shapes. The real key is docs/02 B-14.
 */
const NOW = new Date('2026-09-24T08:00:00Z');
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);

let db: PGlite;
let app: FastifyInstance;
let bare: FastifyInstance;
let fake: ReturnType<typeof createFakeUpwork>;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${fixtureId('a', ENTITY.user)}', 'owner'),
    ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${fixtureId('c', ENTITY.user)}', '${AUTH_VIEWER}', 'c@example.test')`);
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${fixtureId('c', ENTITY.user)}', 'viewer')`,
  );
  fake = createFakeUpwork();
  const config = upworkConfig({
    UPWORK_CLIENT_ID: 'client-id',
    UPWORK_CLIENT_SECRET: 'client-secret',
    APP_URL: 'http://localhost:5173',
    UPWORK_BASE_URL: fake.origin,
  });
  const authenticate = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({ db, authenticate, now: () => NOW, upwork: { config, fetch: fake.fetch } });
  bare = buildServer({ db, authenticate, now: () => NOW });
  await app.ready();
  await bare.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await bare.close();
  await db.close();
});

const start = (who: string, server = app) =>
  server.inject({ method: 'POST', url: '/v1/platform-accounts/upwork/connect', headers: as(who) });
const finish = (who: string, code: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/platform-accounts/upwork/callback',
    headers: as(who),
    payload: { code },
  });

describe('connecting Upwork', () => {
  it('says why it cannot connect without the key, and settings says so too', async () => {
    const response = await start(AUTH_A, bare);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('docs/02 B-14');
    const settings = await bare.inject({ method: 'GET', url: '/v1/settings', headers: as(AUTH_A) });
    expect(settings.json().upwork).toMatchObject({ configured: false });
    const configured = await app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: as(AUTH_A),
    });
    expect(configured.json().upwork).toEqual({
      configured: true,
      environment: 'stand-in',
      reason: null,
    });
  });

  it('hands back the documented authorise URL, logged', async () => {
    const response = await start(AUTH_A);
    expect(response.statusCode).toBe(201);
    const url = new URL(response.json().authorizeUrl);
    expect(url.pathname).toBe('/ab/account-security/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect((await listEvents(db, { type: 'account.connect_started' }))[0]?.payload).toMatchObject({
      platform: 'upwork',
      environment: 'stand-in',
    });
  });

  it('trades the code, names the account, stores the tokens, and logs each call without a token', async () => {
    const response = await finish(AUTH_A, 'code-ok');
    expect(response.statusCode).toBe(201);
    const { account } = response.json();
    expect(account).toMatchObject({
      platform: 'upwork',
      externalUserId: 'up-user-1',
      externalUsername: 'Sample Upwork user',
      status: 'connected',
    });
    expect((await readPlatformTokens(db, account.id))?.accessToken).toBe('access-1');
    const events = await listEvents(db, {});
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['account.connected', 'external.call']),
    );
    expect(JSON.stringify(events)).not.toMatch(/access-1|refresh-1/);
  });

  it('refuses a code nobody is waiting for, and a viewer, and shows another org nothing', async () => {
    const again = await finish(AUTH_A, 'code-ok');
    expect(again.statusCode).toBe(409);
    expect((await start(AUTH_VIEWER)).statusCode).toBe(403);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: as(AUTH_B),
    });
    expect(JSON.stringify(other.json().accounts ?? [])).not.toContain('up-user-1');
  });

  it('a refused code connects nothing and says so', async () => {
    await start(AUTH_B);
    const response = await finish(AUTH_B, 'not-a-code');
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(
      /^Upwork refused the authorisation code.*Nothing was connected/,
    );
    const { rows } = await db.query(
      `select 1 from platform_accounts where org_id = $1 and platform = 'upwork'`,
      [ORG_B],
    );
    expect(rows).toHaveLength(0);
  });
});
