import { insertBriefVersion, listEvents, lockBrief } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-201 acceptance: "Ranking deterministic and explained per supplier". Real Postgres
 * with RLS on; the scores are the ones hand-worked in packages/core/src/sourcing.test.ts.
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
let openBrief: string;
let lockedBrief: string;
let inHouseBrief: string;
let requestId: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

const BRIEF = {
  title: 'Shopify store rebuild',
  outcome: 'A faster shop',
  users: null,
  mustHaves: ['Checkout'],
  later: [],
  references: [],
  assetsProvided: [],
  assetsMissing: [],
  techConstraints: [],
  deadline: '2026-10-13',
  deadlineFixed: false,
  budget: { minMinor: 1000000, maxMinor: 2000000, currency: 'ZAR', type: 'fixed' as const },
  acceptanceCriteria: ['Orders go through'],
  signOff: { name: null, responseTime: null },
  risks: [],
  category: 'wordpress',
  deliveryRoute: 'supplier' as const,
};

async function supplier(
  org: string,
  name: string,
  fields: Record<string, unknown>,
  card: {
    fixed: string | null;
    hourly?: string | null;
    days: number | null;
    currency?: string;
  } | null,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into suppliers (org_id, name, country_code, time_zone, channel, quality_score, on_time_rate, pays_after_delivery, active)
     values ($1, $2, $3, $4, $5::supplier_channel, $6, $7, $8, $9) returning id`,
    [
      org,
      name,
      fields.country ?? 'ZA',
      fields.timeZone ?? 'Africa/Johannesburg',
      fields.channel ?? 'direct',
      fields.quality ?? null,
      fields.onTime ?? null,
      fields.pays ?? false,
      fields.active ?? true,
    ],
  );
  const id = rows[0]!.id;
  if (card) {
    await db.query(
      `insert into supplier_rate_cards (org_id, supplier_id, category_slug, currency, fixed_price_minor, hourly_rate_minor, turnaround_days)
       values ($1, $2, 'wordpress', $3, $4, $5, $6)`,
      [org, id, card.currency ?? 'ZAR', card.fixed, card.hourly ?? null, card.days],
    );
  }
  return id;
}

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
    `insert into service_categories (slug, name, sort_order) values ('wordpress', 'WordPress', 2) on conflict (slug) do nothing`,
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
  const t2 = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5002', 'other-client') returning id`,
    [ORG_A, JOB],
  );
  const t3 = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5003', 'third') returning id`,
    [ORG_A, JOB],
  );

  const open = await insertBriefVersion(db, { orgId: ORG_A, threadId: thread, brief: BRIEF });
  openBrief = open.id;
  const toLock = await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: t2.rows[0]!.id,
    brief: BRIEF,
  });
  const locked = await lockBrief(db, toLock, NOW);
  if (!locked.ok) throw new Error('fixture brief should lock');
  lockedBrief = locked.brief.id;
  const ours = await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: t3.rows[0]!.id,
    brief: { ...BRIEF, deliveryRoute: 'in_house' },
  });
  const lockedOurs = await lockBrief(db, ours, NOW);
  if (!lockedOurs.ok) throw new Error('fixture brief should lock');
  inHouseBrief = lockedOurs.brief.id;

  await supplier(
    ORG_A,
    'Thandi Web',
    { quality: '85.00', onTime: '0.950', pays: true },
    { fixed: '900000', days: 5 },
  );
  await supplier(
    ORG_A,
    'Studio Nord',
    { country: 'NO', timeZone: 'Europe/Oslo', channel: 'upwork', quality: '60.00' },
    { fixed: '1500000', days: 30 },
  );
  await supplier(
    ORG_A,
    'Dollar Shop',
    { channel: 'fiverr' },
    { fixed: '50000', days: 3, currency: 'USD' },
  );
  await supplier(ORG_A, 'No Card', {}, null);
  await supplier(ORG_B, 'Not Ours', { pays: true }, { fixed: '100000', days: 1 });

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

describe('starting sourcing', () => {
  it('needs a locked brief that is not delivered in-house', async () => {
    const unlocked = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${openBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    expect(unlocked.statusCode).toBe(409);
    expect(unlocked.json().error).toBe('The brief must be locked before sourcing starts.');
    const ours = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${inHouseBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    expect(ours.statusCode).toBe(422);
    expect(ours.json().error).toBe(
      'This brief is delivered in-house, so nothing is sourced (docs/02 D-04).',
    );
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${lockedBrief}/sourcing`,
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(403);
    const none = await app.inject({
      method: 'GET',
      url: `/v1/briefs/${lockedBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    expect(none.json()).toEqual({ request: null });
  });

  it('ranks every supplier with a rate card in the category, stores the scores and reasons, and lists the rest with why', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${lockedBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    if (response.statusCode !== 201) console.log(response.body);
    expect(response.statusCode).toBe(201);
    const { request } = response.json();
    requestId = request.id;
    expect(request).toMatchObject({
      briefId: lockedBrief,
      briefTitle: 'Shopify store rebuild',
      category: 'wordpress',
      deliveryRoute: 'supplier',
      clientHandle: 'other-client',
      channels: ['direct', 'upwork'],
      status: 'open',
      candidateCount: 2,
      shortlistedCount: 0,
      excluded: [
        {
          name: 'Dollar Shop',
          reason: 'no ZAR rate card for wordpress; conversion is not guessed',
        },
        { name: 'No Card', reason: 'no rate card for wordpress' },
      ],
    });
    // The same hand-worked scores as core's test: 98 and 57.
    expect(
      request.candidates.map((c: { name: string; score: number }) => [c.name, c.score]),
    ).toEqual([
      ['Thandi Web', 98],
      ['Studio Nord', 57],
    ]);
    expect(request.candidates[0]).toMatchObject({
      channel: 'direct',
      countryCode: 'ZA',
      timeZone: 'Africa/Johannesburg',
      currency: 'ZAR',
      quotedPriceMinor: '900000',
      priced: 'fixed',
      turnaroundDays: 5,
      parts: { rate: 40, turnaround: 20, quality: 18, timeZone: 10, paysAfterDelivery: 10 },
      shortlisted: false,
    });
    expect(request.candidates[0].reasons).toHaveLength(5);
    expect(request.candidates[0].reasons[4]).toBe('accepts payment after delivery');

    const again = await app.inject({
      method: 'POST',
      url: `/v1/briefs/${lockedBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('Sourcing has already started for this brief.');

    expect(await listEvents(db, { type: 'sourcing.requested' })).toHaveLength(1);
    expect((await listEvents(db, { type: 'sourcing.requested' }))[0]?.payload).toMatchObject({
      ranked: 2,
      excluded: 2,
      category: 'wordpress',
    });
    expect(await listEvents(db, { type: 'supplier.candidate_added' })).toHaveLength(2);
  });
});

describe('reading and shortlisting', () => {
  it('lists and shows the request to its organisation only', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/sourcing-requests',
      headers: as(AUTH_A),
    });
    expect(list.json().requests).toHaveLength(1);
    expect(list.json().requests[0]).toMatchObject({ id: requestId, candidateCount: 2 });
    expect(list.json().requests[0].candidates).toBeUndefined();
    const byBrief = await app.inject({
      method: 'GET',
      url: `/v1/briefs/${lockedBrief}/sourcing`,
      headers: as(AUTH_A),
    });
    expect(byBrief.json().request.id).toBe(requestId);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/sourcing-requests/${requestId}`,
      headers: as(AUTH_VIEWER),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().request.candidates).toHaveLength(2);
    const other = await app.inject({
      method: 'GET',
      url: `/v1/sourcing-requests/${requestId}`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
    expect(
      (
        await app.inject({ method: 'GET', url: '/v1/sourcing-requests', headers: as(AUTH_B) })
      ).json().requests,
    ).toEqual([]);
  });

  it('shortlists a candidate and back; the request follows; a viewer may not', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/sourcing-requests/${requestId}`,
      headers: as(AUTH_A),
    });
    const candidate = detail.json().request.candidates[1].id;
    const on = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-requests/${requestId}/candidates/${candidate}`,
      headers: as(AUTH_A),
      payload: { shortlisted: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().request).toMatchObject({ status: 'shortlisting', shortlistedCount: 1 });
    expect(on.json().request.candidates[1]).toMatchObject({
      name: 'Studio Nord',
      shortlisted: true,
    });
    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-requests/${requestId}/candidates/${candidate}`,
      headers: as(AUTH_A),
      payload: { shortlisted: false },
    });
    expect(off.json().request).toMatchObject({ status: 'open', shortlistedCount: 0 });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-requests/${requestId}/candidates/${candidate}`,
      headers: as(AUTH_A),
      payload: { shortlisted: 'yes' },
    });
    expect(bad.statusCode).toBe(422);
    const viewer = await app.inject({
      method: 'PATCH',
      url: `/v1/sourcing-requests/${requestId}/candidates/${candidate}`,
      headers: as(AUTH_VIEWER),
      payload: { shortlisted: true },
    });
    expect(viewer.statusCode).toBe(403);
    expect(await listEvents(db, { type: 'sourcing.shortlisted' })).toHaveLength(2);
  });
});
