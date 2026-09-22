import { listEvents, recordEvent } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-021 acceptance: create, edit and delete via the API, with validation on every
 * field. The dangerous case — turning auto-send on — gets its own tests, because that is
 * the switch that lets the system bid with nobody watching.
 */
let db: PGlite;
let app: FastifyInstance;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);

/** Only the session header: inject sets content-type itself for object payloads, and
 *  sending it without a body makes Fastify answer 400 before the route is reached. */
function as(authUser: string): Record<string, string> {
  return { 'x-test-auth-user': authUser };
}

async function createScanner(
  authUser: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({
    method: 'POST',
    url: '/v1/scanners',
    headers: as(authUser),
    payload: { orgId: ORG_A, ...body },
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);

  await db.exec(`insert into users (id, auth_user_id, email) values
    ('${fixtureId('c', ENTITY.user)}', '${AUTH_VIEWER}', 'c@example.test')`);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${fixtureId('c', ENTITY.user)}', 'viewer')`);

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

describe('creating a scanner', () => {
  it('stores it with safe defaults and writes an event', async () => {
    const response = await createScanner(AUTH_A, { name: 'ZA web builds' });
    expect(response.statusCode).toBe(201);

    const { scanner } = response.json() as { scanner: Record<string, unknown> };
    expect(scanner.name).toBe('ZA web builds');
    expect(scanner.platform).toBe('freelancer');
    expect(scanner.active).toBe(true);
    // Auto-send is off unless someone deliberately turns it on (01 section H).
    expect(scanner.auto_send).toBe(false);
    expect(scanner.daily_cap).toBe(0);
    expect(scanner.min_score).toBeNull();
    expect(scanner.poll_interval_seconds).toBe(120);

    const events = await listEvents(db, { type: 'scanner.created' });
    expect(events[0]?.subject_id).toBe(scanner.id);
    expect(events[0]?.actor_kind).toBe('user');
    expect(events[0]?.actor_user_id).toBe(fixtureId('a', ENTITY.user));
  });

  it('keeps the filters it was given', async () => {
    const response = await createScanner(AUTH_A, {
      name: 'Shopify, paying clients only',
      filters: {
        keywords: ['shopify', 'storefront'],
        categorySlugs: ['shopify'],
        budgetMinMinor: 500000,
        currency: 'ZAR',
        clientCountriesExclude: ['XX'],
        hourly: false,
      },
    });
    expect(response.statusCode).toBe(201);
    const { scanner } = response.json() as { scanner: { filters: Record<string, unknown> } };
    expect(scanner.filters.keywords).toEqual(['shopify', 'storefront']);
    expect(scanner.filters.budgetMinMinor).toBe(500000);
  });

  it('refuses a duplicate name in the same org', async () => {
    await createScanner(AUTH_A, { name: 'Only once' });
    const again = await createScanner(AUTH_A, { name: 'Only once' });
    expect(again.statusCode).toBe(409);
  });
});

describe('validation', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['an empty name', { name: '   ' }, 'name'],
    ['no name at all', {}, 'name'],
    ['a platform that does not exist', { name: 'x1', platform: 'peopleperhour' }, 'platform'],
    [
      'polling faster than the floor',
      { name: 'x2', pollIntervalSeconds: 30 },
      'pollIntervalSeconds',
    ],
    ['a fractional interval', { name: 'x3', pollIntervalSeconds: 90.5 }, 'pollIntervalSeconds'],
    ['a score above 100', { name: 'x4', minScore: 101 }, 'minScore'],
    ['a negative daily cap', { name: 'x5', dailyCap: -1 }, 'dailyCap'],
    ['a daily cap beyond the ceiling', { name: 'x6', dailyCap: 5000 }, 'dailyCap'],
    ['active as a string', { name: 'x7', active: 'yes' }, 'active'],
    ['filters that are not an object', { name: 'x8', filters: [] }, 'filters'],
    ['a filter nobody understands', { name: 'x9', filters: { colour: 'blue' } }, 'filters.colour'],
    [
      'a budget floor with no currency',
      { name: 'x10', filters: { budgetMinMinor: 1000 } },
      'filters.currency',
    ],
    [
      'a country code that is not a country code',
      { name: 'x11', filters: { clientCountriesInclude: ['South Africa'] } },
      'filters.clientCountriesInclude[0]',
    ],
    [
      'a country both included and excluded',
      {
        name: 'x12',
        filters: { clientCountriesInclude: ['ZA'], clientCountriesExclude: ['ZA'] },
      },
      'filters.clientCountriesExclude',
    ],
    ['a field that is not a field', { name: 'x13', colour: 'blue' }, 'colour'],
  ];

  it.each(cases)('refuses %s, and says which field', async (_label, body, field) => {
    const response = await createScanner(AUTH_A, body);
    expect(response.statusCode).toBe(422);
    const { errors } = response.json() as { errors: { field: string }[] };
    expect(errors.map((e) => e.field)).toContain(field);
  });

  it('names every bad field at once rather than one at a time', async () => {
    const response = await createScanner(AUTH_A, {
      name: '',
      platform: 'nope',
      pollIntervalSeconds: 1,
      dailyCap: -5,
    });
    const { errors } = response.json() as { errors: { field: string }[] };
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('auto-send', () => {
  it('is refused without a daily cap and a minimum score', async () => {
    const response = await createScanner(AUTH_A, { name: 'Reckless', autoSend: true });
    expect(response.statusCode).toBe(422);
    const { errors } = response.json() as { errors: { field: string }[] };
    expect(errors.map((e) => e.field).sort()).toEqual(['dailyCap', 'minScore']);
  });

  it('is allowed with both', async () => {
    const response = await createScanner(AUTH_A, {
      name: 'Careful',
      autoSend: true,
      dailyCap: 5,
      minScore: 80,
    });
    expect(response.statusCode).toBe(201);
  });

  it('cannot be left on by clearing the cap in a later edit', async () => {
    const created = await createScanner(AUTH_A, {
      name: 'Two-step',
      autoSend: true,
      dailyCap: 5,
      minScore: 80,
    });
    const { scanner } = created.json() as { scanner: { id: string } };

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
      payload: { dailyCap: 0 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { errors: { field: string }[] }).errors[0]?.field).toBe('dailyCap');
  });

  it('cannot be turned on by an edit that supplies no guardrails', async () => {
    const created = await createScanner(AUTH_A, { name: 'Quiet then loud' });
    const { scanner } = created.json() as { scanner: { id: string } };

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
      payload: { autoSend: true },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('editing', () => {
  it('changes only what was sent, and records what changed', async () => {
    const created = await createScanner(AUTH_A, { name: 'Before', pollIntervalSeconds: 300 });
    const { scanner } = created.json() as { scanner: { id: string } };

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
      payload: { name: 'After' },
    });
    expect(response.statusCode).toBe(200);
    const updated = (response.json() as { scanner: Record<string, unknown> }).scanner;
    expect(updated.name).toBe('After');
    expect(updated.poll_interval_seconds).toBe(300);

    const events = await listEvents(db, { type: 'scanner.updated', subjectId: scanner.id });
    expect(events[0]?.payload).toMatchObject({ changed: ['name'] });
  });

  it('refuses an edit with nothing in it', async () => {
    const created = await createScanner(AUTH_A, { name: 'Unchanged' });
    const { scanner } = created.json() as { scanner: { id: string } };
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('deleting', () => {
  it('removes it and records the deletion', async () => {
    const created = await createScanner(AUTH_A, { name: 'Temporary' });
    const { scanner } = created.json() as { scanner: { id: string } };

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/scanners/${scanner.id}`,
      headers: as(AUTH_A),
    });
    expect(gone.statusCode).toBe(404);

    const events = await listEvents(db, { type: 'scanner.deleted', subjectId: scanner.id });
    expect(events[0]?.payload).toMatchObject({ name: 'Temporary' });
  });
});

describe('who may do what', () => {
  it('turns away a request with no session', async () => {
    for (const [method, url, body] of [
      ['GET', '/v1/scanners', undefined],
      ['POST', '/v1/scanners', {}],
      ['PATCH', `/v1/scanners/${fixtureId('a', ENTITY.scanner)}`, {}],
      ['DELETE', `/v1/scanners/${fixtureId('a', ENTITY.scanner)}`, undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(body ? { payload: body } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a viewer', async () => {
    const response = await createScanner(AUTH_VIEWER, { name: 'By a viewer' });
    expect(response.statusCode).toBe(403);
  });

  it('hides another org s scanners, and will not create one there', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/scanners', headers: as(AUTH_B) });
    const { scanners } = list.json() as { scanners: { org_id: string }[] };
    expect(scanners.every((s) => s.org_id === ORG_B)).toBe(true);

    const create = await createScanner(AUTH_B, { name: 'Trespassing' });
    expect(create.statusCode).toBe(403);
  });

  it('answers 404, not 403, for another org s scanner by id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/scanners/${fixtureId('a', ENTITY.scanner)}`,
      headers: as(AUTH_B),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an id that is not a uuid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/scanners/not-a-uuid',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the audit trail', () => {
  it('records nothing when a write was refused', async () => {
    const before = await listEvents(db, { type: 'scanner.created', limit: 100 });
    await createScanner(AUTH_VIEWER, { name: 'Never happened' });
    const after = await listEvents(db, { type: 'scanner.created', limit: 100 });
    expect(after.length).toBe(before.length);
  });
});

// Keeps the unused import honest: recordEvent is exercised through the routes.
void recordEvent;
