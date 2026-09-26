import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-400: someone who has just signed up creates their org and becomes its owner, then
 * sees what is left to set up. Real Postgres with RLS on; the person is identified the
 * way the Supabase verifier would, by their auth user id.
 */
let db: PGlite;
let app: FastifyInstance;
let pending: FastifyInstance;
const LOGI_INK = fixtureId('a', ENTITY.org);
const AUTH_LOGI_INK = fixtureId('a', ENTITY.authUser);
const AUTH_NEW = fixtureId('e', ENTITY.authUser);
const AUTH_OTHER = fixtureId('f', ENTITY.authUser);
const AUTH_GHOST = fixtureId('9', ENTITY.authUser);

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
/** The terms on show (ARB-522); each form below accepts them unless it says otherwise. */
const TERMS = { version: 'v1', approvedOn: '2026-10-01' };
const create = (who: string, payload: Record<string, unknown>, server = () => app) =>
  server().inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: as(who),
    payload: { termsVersion: TERMS.version, ...payload },
  });
const onboarding = (who: string) =>
  app.inject({ method: 'GET', url: '/v1/onboarding', headers: as(who) });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  await db.exec(`update orgs set name = 'Logi-Ink' where id = '${LOGI_INK}'`);
  for (const row of tenantRows(LOGI_INK, 'a', 'a')) await db.exec(row.sql);
  // Two people sign up; Supabase creates their identities and 0009's trigger their users.
  for (const [auth, email] of [
    [AUTH_NEW, 'new@example.test'],
    [AUTH_OTHER, 'other@example.test'],
  ] as const) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [auth, email]);
  }
  const authenticate = (request: { headers: unknown }) => {
    const header = (request.headers as Record<string, unknown>)['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({ db, authenticate, terms: TERMS });
  await app.ready();
  // The same API before the owner publishes the terms (D-16).
  pending = buildServer({ db, authenticate, terms: null });
  await pending.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await pending.close();
  await db.close();
});

describe('before an org exists', () => {
  it('turns away a request with no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/orgs', payload: {} });
    expect(response.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/onboarding' })).statusCode).toBe(401);
  });

  it('says a new person is in no org yet', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: as(AUTH_NEW) })).statusCode,
    ).toBe(403);
    expect((await onboarding(AUTH_NEW)).statusCode).toBe(403);
  });

  it('names each field the form got wrong, and creates nothing', async () => {
    const response = await create(AUTH_NEW, { name: ' ', countryCode: 'South Africa' });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors).toEqual([
      { field: 'name', message: 'is required' },
      { field: 'countryCode', message: 'must be a two-letter ISO 3166-1 code, such as ZA' },
    ]);
    const { rows } = await db.query<{ count: number }>(`select count(*)::int as count from orgs`);
    expect(rows[0]?.count).toBe(1);
  });

  it('while the terms of service are pending, no org can be made (ARB-522)', async () => {
    const response = await create(AUTH_NEW, { name: 'Too Soon' }, () => pending);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/until the terms of service are published/);
    const { rows } = await db.query<{ count: number }>(`select count(*)::int as count from orgs`);
    expect(rows[0]?.count).toBe(1);
  });

  it('needs the terms accepted, and the version on show (ARB-522)', async () => {
    const none = await create(AUTH_NEW, { name: 'No Terms', termsVersion: undefined });
    expect(none.statusCode).toBe(422);
    expect(none.json().errors).toEqual([
      { field: 'terms', message: 'must be accepted to create an organisation' },
    ]);
    const stale = await create(AUTH_NEW, { name: 'Old Terms', termsVersion: 'v0' });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().errors).toEqual([
      {
        field: 'terms',
        message: 'must be the terms of service on show now: reload the page and accept them',
      },
    ]);
    const { rows } = await db.query<{ count: number }>(`select count(*)::int as count from orgs`);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('POST /v1/orgs', () => {
  it('creates the org with the person as owner, and answers like /v1/me', async () => {
    const response = await create(AUTH_NEW, { name: '  New Studio ', countryCode: 'za' });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      user: { email: 'new@example.test', fullName: null, telegramLinked: false },
      org: { name: 'New Studio', baseCurrency: 'ZAR' },
      role: 'owner',
    });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: as(AUTH_NEW) });
    expect(me.json()).toEqual(body);

    const events = await db.query<{ request_id: string | null }>(
      `select request_id from events where type = 'org.created' and org_id = $1`,
      [body.org.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.request_id).toBeTruthy();

    const accepted = await db.query<{ version: string }>(
      `select a.version from terms_acceptances a join users u on u.id = a.user_id
        where u.auth_user_id = $1`,
      [AUTH_NEW],
    );
    expect(accepted.rows).toEqual([{ version: 'v1' }]);
  });

  it('refuses a second org for the same person', async () => {
    const response = await create(AUTH_NEW, { name: 'Another' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/already a member of an organisation/);
  });

  it('refuses a member of Logi-Ink, who is already in an org', async () => {
    const response = await create(AUTH_LOGI_INK, { name: 'Side project' });
    expect(response.statusCode).toBe(409);
  });

  it('refuses a sign-in with no application user behind it', async () => {
    const response = await create(AUTH_GHOST, { name: 'Ghost' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/no account behind it/);
  });

  it('keeps the two orgs apart: each person sees only their own', async () => {
    const mine = await create(AUTH_OTHER, { name: 'Other Co' });
    expect(mine.statusCode).toBe(201);
    const otherOrg = mine.json().org.id as string;

    const settings = await app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: as(AUTH_OTHER),
    });
    expect(settings.statusCode).toBe(200);
    expect(JSON.stringify(settings.json())).not.toContain(LOGI_INK);

    const events = await app.inject({ method: 'GET', url: '/v1/events', headers: as(AUTH_OTHER) });
    const types = (events.json().events as { orgId?: string; type: string }[]).map((e) => e.type);
    expect(types).toEqual(['org.created']);

    const jobs = await app.inject({ method: 'GET', url: '/v1/jobs', headers: as(AUTH_OTHER) });
    expect(JSON.stringify(jobs.json())).not.toContain(fixtureId('a', ENTITY.job));

    const logiInk = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: as(AUTH_LOGI_INK),
    });
    expect(JSON.stringify(logiInk.json())).not.toContain(otherOrg);
  });
});

describe('GET /v1/onboarding', () => {
  it('lists every step, with only the org done for a new org', async () => {
    const response = await onboarding(AUTH_NEW);
    expect(response.statusCode).toBe(200);
    const { steps, org, role } = response.json();
    expect(org.name).toBe('New Studio');
    expect(role).toBe('owner');
    expect((steps as { key: string; done: boolean }[]).map((s) => [s.key, s.done])).toEqual([
      ['org', true],
      ['margin', false],
      ['freelancer', false],
      ['scanner', false],
      ['template', false],
      ['telegram', false],
    ]);
  });

  it('ticks each step from the org s own rows', async () => {
    await db.exec(`update platform_accounts set status = 'expired' where org_id = '${LOGI_INK}'`);
    const response = await onboarding(AUTH_LOGI_INK);
    const done = (response.json().steps as { key: string; done: boolean }[])
      .filter((s) => s.done)
      .map((s) => s.key);
    // Logi-Ink's fixtures: a scanner, an active template with an active variant, a
    // linked Telegram chat. Its Freelancer account has expired and no margin rule is set.
    expect(done).toEqual(['org', 'scanner', 'template', 'telegram']);

    await db.exec(`update settings set min_margin_pct = 30, min_margin_zar_minor = 50000,
      fx_buffer_pct = 2, fee_table = '[{"platform":"freelancer"}]'::jsonb where org_id = '${LOGI_INK}'`);
    await db.exec(`update platform_accounts set status = 'connected' where org_id = '${LOGI_INK}'`);
    const after = await onboarding(AUTH_LOGI_INK);
    expect((after.json().steps as { done: boolean }[]).every((s) => s.done)).toBe(true);
  });
});
