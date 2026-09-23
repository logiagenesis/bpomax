import { buildSeedSql } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-013: `GET /v1/price-bands`, against real Postgres with RLS on and the real seed
 * applied. The seed ships no bands (D-14), so the first case is the page's empty state;
 * the rest add bands the way an owner's CSV or a seed file would, to show each is
 * listed with its category's name and its source, which the page turns into the label.
 */
let db: PGlite;
let app: FastifyInstance;

const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_STRANGER = fixtureId('f', ENTITY.authUser);
const ORG_A = fixtureId('a', ENTITY.org);
const USER_VIEWER = fixtureId('c', ENTITY.user);
const USER_STRANGER = fixtureId('f', ENTITY.user);

function as(authUser: string): Record<string, string> {
  return { 'x-test-auth-user': authUser };
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(buildSeedSql());
  for (const row of identityRows('a')) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role)
    values ('${ORG_A}', '${fixtureId('a', ENTITY.user)}', 'owner')`);
  // A viewer in org A, and a signed-in person with no org at all.
  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${USER_VIEWER}', '${AUTH_VIEWER}', 'c@example.test'),
    ('${USER_STRANGER}', '${AUTH_STRANGER}', 'f@example.test')`);
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${USER_VIEWER}', 'viewer')`,
  );

  const authenticate = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({ db, authenticate });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /v1/price-bands', () => {
  it('lists no band on the seeded database, and counts the 22 categories', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/price-bands',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: 22, bands: [] });
  });

  it('lists each band with its category name and source, in the taxonomy’s order', async () => {
    // The seed's own order puts website-build before seo (service-categories.json).
    await db.exec(`insert into market_price_bands
      (category_slug, currency, p25_minor, p50_minor, p75_minor, sample_size, source, sampled_at) values
      ('seo', 'ZAR', 200000, 400000, 800000, 0, 'seed', '2026-09-20T08:00:00Z'),
      ('website-build', 'USD', 30000, 60000, 90000, 14, 'owner_csv', '2026-09-21T08:00:00Z'),
      ('website-build', 'ZAR', 150000, 300000, 600000, 0, 'seed', '2026-09-20T08:00:00Z')`);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/price-bands',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.categories).toBe(22);
    expect(
      body.bands.map(
        (b: Record<string, unknown>) => `${String(b.categorySlug)} ${String(b.currency)}`,
      ),
    ).toEqual(['website-build USD', 'website-build ZAR', 'seo ZAR']);
    expect(body.bands[1]).toMatchObject({
      categorySlug: 'website-build',
      categoryName: 'Website build',
      currency: 'ZAR',
      // Money is text on the wire (D-035).
      p25Minor: '150000',
      p50Minor: '300000',
      p75Minor: '600000',
      sampleSize: 0,
      source: 'seed',
    });
    expect(body.bands[0]).toMatchObject({ source: 'owner_csv', sampleSize: 14 });
    expect(Date.parse(body.bands[0].sampledAt)).toBe(Date.parse('2026-09-21T08:00:00Z'));
  });

  it('is readable by a viewer, refused unsigned, and refused to someone with no org', async () => {
    const viewer = await app.inject({
      method: 'GET',
      url: '/v1/price-bands',
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().bands).toHaveLength(3);

    const unsigned = await app.inject({ method: 'GET', url: '/v1/price-bands' });
    expect(unsigned.statusCode).toBe(401);

    const stranger = await app.inject({
      method: 'GET',
      url: '/v1/price-bands',
      headers: as(AUTH_STRANGER),
    });
    expect(stranger.statusCode).toBe(403);
  });
});
