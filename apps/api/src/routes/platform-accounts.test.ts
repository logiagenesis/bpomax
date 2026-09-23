import { listEvents, readPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import { freelancerConfig, getSelf, type FreelancerConfig } from '@arbitron/freelancer';
import { startFakeFreelancer, type FakeFreelancer } from '@arbitron/freelancer/fake';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-020 acceptance, against real Postgres with RLS on and the Freelancer.com stand-in
 * over real HTTP: "Connect and disconnect work in sandbox; tokens encrypted at rest;
 * second account for same identity rejected". The sandbox itself is C-02; encryption at
 * rest is proven on the real Vault in CI (scripts/db-verify-vault.sql).
 */
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const LOGIINK = { id: 424242, username: 'logiink' };
const OTHER = { id: 515151, username: 'someone-else' };

let db: PGlite;
let app: FastifyInstance;
let bare: FastifyInstance;
let fake: FakeFreelancer;
let config: FreelancerConfig;

function as(authUser: string): Record<string, string> {
  return { 'x-test-auth-user': authUser };
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${fixtureId('a', ENTITY.user)}', 'owner'),
    ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }

  fake = await startFakeFreelancer({ user: LOGIINK });
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;

  const authenticate = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({ db, authenticate, now: () => NOW, freelancer: { config: result } });
  bare = buildServer({ db, authenticate, now: () => NOW });
  await app.ready();
  await bare.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await bare.close();
  await fake.close();
  await db.close();
});

async function connect(authUser: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/platform-accounts/freelancer/connect',
    headers: as(authUser),
  });
}

/** The browser's round trip: follow the authorise URL to the stand-in, read the code. */
async function consent(authorizeUrl: string): Promise<string> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

async function callback(authUser: string, code: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/platform-accounts/freelancer/callback',
    headers: as(authUser),
    payload: { code },
  });
}

async function accountOf(orgId: string) {
  const { rows } = await db.query<{ id: string; status: string; external_user_id: string }>(
    `select id, status::text as status, external_user_id from platform_accounts where org_id = $1`,
    [orgId],
  );
  return rows[0];
}

describe('connecting', () => {
  it('is refused, naming B-03, while Freelancer.com is not configured', async () => {
    const response = await bare.inject({
      method: 'POST',
      url: '/v1/platform-accounts/freelancer/connect',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/docs\/02 B-03/);
    const settings = await bare.inject({ method: 'GET', url: '/v1/settings', headers: as(AUTH_A) });
    expect(settings.json().freelancer).toMatchObject({ configured: false, environment: null });
  });

  it('refuses a viewer, and anyone signed out', async () => {
    expect((await connect(AUTH_VIEWER)).statusCode).toBe(403);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/platform-accounts/freelancer/connect',
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('starts with the documented authorise URL and a ten-minute attempt, logged', async () => {
    const response = await connect(AUTH_A);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.authorizeUrl).toBe(
      `${fake.url}/oauth/authorize?response_type=code&client_id=${fake.clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=basic` +
        '&advanced_scopes=1%202%205%206&prompt=select_account%20consent',
    );
    expect(body.expiresAt).toBe('2026-09-23T10:10:00.000Z');
    const [event] = await listEvents(db, { type: 'account.connect_started' });
    expect(event).toMatchObject({ org_id: ORG_A, actor_kind: 'user' });
  });

  it('connects on the callback: the account, its identity, and tokens held only in Vault', async () => {
    const started = (await connect(AUTH_A)).json();
    const response = await callback(AUTH_A, await consent(started.authorizeUrl));
    expect(response.statusCode).toBe(201);
    const { account } = response.json();
    expect(account).toMatchObject({
      platform: 'freelancer',
      externalUserId: '424242',
      externalUsername: 'logiink',
      status: 'connected',
      scopes: ['basic', '1', '2', '5', '6'],
    });
    // The stored token is a real one: the stand-in accepts it for the account lookup.
    const tokens = await readPlatformTokens(db, account.id);
    expect(tokens?.expiresAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    expect((await getSelf(config, tokens!.accessToken)).id).toBe('424242');
    // No token in the response, in the account row, or in the audit log.
    expect(response.body).not.toContain(tokens!.accessToken);
    const row = await db.query('select * from platform_accounts where id = $1', [account.id]);
    expect(JSON.stringify(row.rows)).not.toContain(tokens!.accessToken);
    const events = await listEvents(db, {});
    expect(JSON.stringify(events)).not.toContain(tokens!.accessToken);
    expect(JSON.stringify(events)).not.toContain(tokens!.refreshToken!);
    const connected = events.find((e) => e.type === 'account.connected');
    expect(connected).toMatchObject({ outcome: 'ok', subject_id: account.id });
    expect(events.filter((e) => e.type === 'external.call').map((e) => e.payload.call)).toEqual(
      expect.arrayContaining(['oauth/token', 'users/0.1/self']),
    );
  });

  it('a code is accepted once: the attempt is spent', async () => {
    const response = await callback(AUTH_A, fake.issueCode(REDIRECT));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Start again from Settings/);
  });

  it('a code for someone who never started a connect is refused', async () => {
    const response = await callback(AUTH_OPERATOR, fake.issueCode(REDIRECT));
    expect(response.statusCode).toBe(409);
  });

  it('refuses a second org the same Freelancer.com identity: one account per identity', async () => {
    const started = (await connect(AUTH_B)).json();
    const response = await callback(AUTH_B, await consent(started.authorizeUrl));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/already connected to another organisation/);
    expect(await accountOf(ORG_B)).toBeUndefined();
  });

  it('refuses a second identity in an org whose account is still connected', async () => {
    fake.signInAs(OTHER);
    const started = (await connect(AUTH_OPERATOR)).json();
    const response = await callback(AUTH_OPERATOR, await consent(started.authorizeUrl));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Disconnect it first/);
    expect((await accountOf(ORG_A))?.external_user_id).toBe('424242');
    fake.signInAs(LOGIINK);
  });

  it('a code Freelancer.com refuses is a 502 that says so, logged, with nothing connected', async () => {
    await connect(AUTH_A);
    const response = await callback(AUTH_A, 'not-a-real-code');
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(
      /^Freelancer.com refused the authorisation code \(HTTP 400: Invalid authorisation code\)/,
    );
    const failed = (await listEvents(db, { type: 'account.connected' })).find(
      (e) => e.outcome === 'error',
    );
    expect(failed).toBeDefined();
  });

  it('settings reports the connection is configured, against a stand-in', async () => {
    const settings = await app.inject({ method: 'GET', url: '/v1/settings', headers: as(AUTH_A) });
    expect(settings.json().freelancer).toEqual({
      configured: true,
      environment: 'stand-in',
      reason: null,
    });
    expect(settings.json().accounts[0]).toMatchObject({ externalUsername: 'logiink' });
  });
});

describe('disconnecting', () => {
  it('answers 404 to another org and 403 to a viewer, changing nothing', async () => {
    const account = await accountOf(ORG_A);
    const other = await app.inject({
      method: 'POST',
      url: `/v1/platform-accounts/${account!.id}/disconnect`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/platform-accounts/${account!.id}/disconnect`,
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(403);
    expect(await readPlatformTokens(db, account!.id)).not.toBeNull();
  });

  it('an operator disconnects: the tokens are deleted, the row kept, and it is logged', async () => {
    const account = await accountOf(ORG_A);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform-accounts/${account!.id}/disconnect`,
      headers: as(AUTH_OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().account).toMatchObject({ status: 'disconnected' });
    expect(await readPlatformTokens(db, account!.id)).toBeNull();
    const [event] = await listEvents(db, { type: 'account.disconnected' });
    expect(event).toMatchObject({ subject_id: account!.id, actor_kind: 'user' });
  });

  it('once disconnected, another identity may be connected, and the change is recorded', async () => {
    fake.signInAs(OTHER);
    const started = (await connect(AUTH_A)).json();
    const response = await callback(AUTH_A, await consent(started.authorizeUrl));
    expect(response.statusCode).toBe(201);
    expect(response.json().account).toMatchObject({
      externalUserId: '515151',
      status: 'connected',
    });
    const latest = (await listEvents(db, { type: 'account.connected' })).find(
      (e) => e.outcome === 'ok',
    );
    expect(latest?.payload).toMatchObject({ replaced_external_user_id: '424242' });
  });
});
