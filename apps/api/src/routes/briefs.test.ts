import { listEvents, startDiscoverySession, captureDiscoveryAnswers } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-131 acceptance: "Brief cannot lock with missing required fields; versions
 * preserved". Real Postgres with RLS on; the category table is the real seed.
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
let thread: string;
let briefId: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

const FULL = {
  title: 'Shopify store rebuild',
  outcome: 'A faster shop',
  users: 'Customers',
  mustHaves: ['Checkout', 'Product pages'],
  later: ['Loyalty'],
  references: [],
  assetsProvided: ['Domain'],
  assetsMissing: [],
  techConstraints: ['Shopify'],
  deadline: '2026-11-30',
  deadlineFixed: false,
  budget: { minMinor: 1500000, maxMinor: 2000000, currency: 'ZAR', type: 'fixed' },
  acceptanceCriteria: ['Orders go through'],
  signOff: { name: 'Thandi', responseTime: 'same day' },
  risks: [],
  category: 'shopify',
  deliveryRoute: 'in_house',
};

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
    `insert into service_categories (slug, name, sort_order) values ('shopify', 'Shopify', 5) on conflict (slug) do nothing`,
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
  const session = await startDiscoverySession(db, { orgId: ORG_A, threadId: thread });
  await captureDiscoveryAnswers(
    db,
    session,
    { outcome: 'A faster shop', users: 'Customers', acceptance: 'Orders go through' },
    'client',
    NOW,
  );
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

describe('the brief', () => {
  it('is drafted as version 1 from the discovery answers, unlocked, with what a lock still needs named', async () => {
    const none = await app.inject({
      method: 'GET',
      url: `/v1/threads/${thread}/brief`,
      headers: as(AUTH_A),
    });
    expect(none.json()).toEqual({ brief: null, versions: [] });
    const drafted = await app.inject({
      method: 'POST',
      url: `/v1/threads/${thread}/brief`,
      headers: as(AUTH_A),
    });
    expect(drafted.statusCode).toBe(201);
    const brief = drafted.json().brief;
    briefId = brief.id;
    expect(brief).toMatchObject({
      version: 1,
      locked: false,
      title: 'Shopify store rebuild',
      outcome: 'A faster shop',
      users: 'Customers',
      acceptanceCriteria: ['Orders go through'],
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      lockBlockers: ['a service category', 'a delivery route', 'at least one must-have'],
    });
    expect((await listEvents(db, { type: 'brief.drafted' }))[0]?.payload).toMatchObject({
      version: 1,
      from: 'discovery',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/threads/${thread}/brief`,
          headers: as(AUTH_A),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('cannot lock with missing required fields, and says which; a viewer cannot change it', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${briefId}/lock`,
      headers: as(AUTH_A),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe(
      'The brief cannot lock without a service category, a delivery route, at least one must-have.',
    );
    const still = await app.inject({
      method: 'GET',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
    });
    expect(still.json().brief.locked).toBe(false);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/briefs/${briefId}`,
          headers: as(AUTH_VIEWER),
          payload: FULL,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/briefs/${briefId}`, headers: as(AUTH_B) }))
        .statusCode,
    ).toBe(404);
  });

  it('is validated on save, the category against the real table, and locks once complete', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
      payload: { ...FULL, deadline: '30/11/2026' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toEqual([
      { field: 'deadline', message: 'must be a date as YYYY-MM-DD' },
    ]);
    const unknown = await app.inject({
      method: 'PUT',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
      payload: { ...FULL, category: 'nope' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().errors).toEqual([
      { field: 'category', message: 'is not a service category' },
    ]);

    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
      payload: FULL,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().brief).toMatchObject({
      budget: { minMinor: 1500000, currency: 'ZAR' },
      deadline: '2026-11-30',
      lockBlockers: [],
    });
    expect((await listEvents(db, { type: 'brief.updated' }))[0]?.payload).toMatchObject({
      version: 1,
      lock_blockers: [],
    });

    const locked = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${briefId}/lock`,
      headers: as(AUTH_A),
    });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().brief).toMatchObject({
      locked: true,
      lockedAt: NOW.toISOString(),
      lockBlockers: [],
    });
    expect((await listEvents(db, { type: 'brief.locked' }))[0]?.payload).toMatchObject({
      version: 1,
      category: 'shopify',
      delivery_route: 'in_house',
    });
    expect(
      (await app.inject({ method: 'POST', url: `/v1/briefs/${briefId}/lock`, headers: as(AUTH_A) }))
        .statusCode,
    ).toBe(409);
  });

  it('a locked version is never edited: a change is a new version, and the old one is kept as it was', async () => {
    const edit = await app.inject({
      method: 'PUT',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
      payload: { ...FULL, title: 'Changed' },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe(
      'Version 1 is locked and cannot be changed. Start a new version to change it.',
    );

    const next = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${briefId}/versions`,
      headers: as(AUTH_A),
    });
    expect(next.statusCode).toBe(201);
    const v2 = next.json().brief;
    expect(v2).toMatchObject({
      version: 2,
      locked: false,
      title: 'Shopify store rebuild',
      mustHaves: ['Checkout', 'Product pages'],
    });
    const changed = await app.inject({
      method: 'PUT',
      url: `/v1/briefs/${v2.id}`,
      headers: as(AUTH_A),
      payload: { ...FULL, title: 'Shopify store rebuild, phase two' },
    });
    expect(changed.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/threads/${thread}/brief`,
      headers: as(AUTH_A),
    });
    expect(list.json().brief).toMatchObject({
      version: 2,
      title: 'Shopify store rebuild, phase two',
      locked: false,
    });
    expect(
      list.json().versions.map((v: { version: number; locked: boolean }) => [v.version, v.locked]),
    ).toEqual([
      [2, false],
      [1, true],
    ]);
    const old = await app.inject({
      method: 'GET',
      url: `/v1/briefs/${briefId}`,
      headers: as(AUTH_A),
    });
    expect(old.json().brief).toMatchObject({
      version: 1,
      locked: true,
      title: 'Shopify store rebuild',
    });
    // A third version cannot start while the second is open.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/briefs/${briefId}/versions`,
          headers: as(AUTH_A),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('the database itself refuses a lock without the required fields', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into briefs (org_id, thread_id, version, title, outcome) values ($1, $2, 9, 'T', 'O') returning id`,
      [ORG_A, thread],
    );
    await expect(
      db.query(`update briefs set locked = true, locked_at = now() where id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/locked_brief_is_complete/);
    await db.query('delete from briefs where id = $1', [rows[0]!.id]);
  });
});
