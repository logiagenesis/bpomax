import { SUPPLIER_CSV_COLUMNS, supplierCsvTemplate, validateSupplierCsv } from '@arbitron/core';
import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-200 acceptance: "CSV template downloadable; import validates every row with
 * line-numbered errors". Real Postgres with RLS on; the categories are the real seed.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let app: FastifyInstance;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
const HEADING = SUPPLIER_CSV_COLUMNS.join(',');
const GOOD = [
  HEADING,
  'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,https://example.com/thandi,"Fast, careful",yes,wordpress,ZAR,"1 500,00",,5',
  'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,https://example.com/thandi,"Fast, careful",yes,seo,ZAR,,350.5,',
  'Studio Nord,NO,Europe/Oslo,upwork,en,,,no,,,no,,,,,',
].join('\r\n');

const count = async (table: string) =>
  Number(
    (await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n ?? 0,
  );

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
    `insert into service_categories (slug, name, sort_order) values ('wordpress', 'WordPress', 2), ('seo', 'SEO', 11) on conflict (slug) do nothing`,
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

describe('the template', () => {
  it('downloads as a CSV file with the columns the import expects', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/suppliers/template.csv',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="suppliers-template.csv"',
    );
    expect(response.body).toBe(supplierCsvTemplate());
    expect(response.body.split('\r\n')[0]).toBe(HEADING);
    const anonymous = await app.inject({ method: 'GET', url: '/v1/suppliers/template.csv' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the import', () => {
  it('refuses a file with problems, names every line, and writes nothing', async () => {
    const bad = [
      HEADING,
      'Fine,ZA,,direct,,,,yes,,,yes,wordpress,ZAR,100,,',
      ',ZA,,direct,,,,yes,,,yes,,,,,',
      'Bad,ZA,,telepathy,,,,yes,,,yes,plumbing,ZAR,abc,,',
    ].join('\n');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: bad },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('2 lines have problems; nothing was imported.');
    expect(response.json().errors).toEqual([
      { line: 3, field: 'name', message: 'must not be empty' },
      { line: 4, field: 'channel', message: expect.stringContaining('must be one of') },
      { line: 4, field: 'category_slug', message: 'is not a service category' },
      { line: 4, field: 'fixed_price', message: 'must be an amount such as 1500.00' },
    ]);
    expect(await count('suppliers')).toBe(0);
    expect(await count('supplier_rate_cards')).toBe(0);
  });

  it('refuses the template itself, because its sample line is not a supplier', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: supplierCsvTemplate() },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors[0]).toMatchObject({ line: 2, field: 'name' });
  });

  it('checks without writing when asked to', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: GOOD, dryRun: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      dryRun: true,
      lines: 3,
      suppliers: 2,
      rateCards: 2,
      created: 0,
      updated: 0,
    });
    expect(await count('suppliers')).toBe(0);
  });

  it('writes a good file: suppliers by name, rate cards in minor units, and one event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: GOOD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      dryRun: false,
      lines: 3,
      suppliers: 2,
      rateCards: 2,
      created: 2,
      updated: 0,
    });
    const cards = await db.query<{
      name: string;
      category_slug: string;
      fixed: string | null;
      hourly: string | null;
      turnaround_days: number | null;
    }>(
      `select s.name, r.category_slug, r.fixed_price_minor::text as fixed, r.hourly_rate_minor::text as hourly, r.turnaround_days
         from supplier_rate_cards r join suppliers s on s.id = r.supplier_id order by r.category_slug`,
    );
    // Hand-worked: R1 500,00 is 150 000 cents; R350,50 an hour is 35 050 cents.
    expect(cards.rows).toEqual([
      {
        name: 'Thandi Web',
        category_slug: 'seo',
        fixed: null,
        hourly: '35050',
        turnaround_days: null,
      },
      {
        name: 'Thandi Web',
        category_slug: 'wordpress',
        fixed: '150000',
        hourly: null,
        turnaround_days: 5,
      },
    ]);
    const nord = await db.query<{ active: boolean; pays_after_delivery: boolean; org_id: string }>(
      `select active, pays_after_delivery, org_id from suppliers where name = 'Studio Nord'`,
    );
    expect(nord.rows[0]).toEqual({ active: false, pays_after_delivery: false, org_id: ORG_A });
    const events = await listEvents(db, { type: 'supplier.imported' });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      suppliers: 2,
      rate_cards: 2,
      created: 2,
      updated: 0,
    });
  });

  it('imports the same names again as an update, never a duplicate, and keeps cards not in the file', async () => {
    const again = [
      HEADING,
      'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,90,0.97,yes,https://example.com/thandi,Even better,yes,wordpress,ZAR,1600,,4',
    ].join('\n');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: again },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ suppliers: 1, rateCards: 1, created: 0, updated: 1 });
    expect(await count('suppliers')).toBe(2);
    expect(await count('supplier_rate_cards')).toBe(2);
    const row = await db.query<{ quality_score: string; fixed: string; notes: string }>(
      `select s.quality_score::text, r.fixed_price_minor::text as fixed, s.notes
         from suppliers s join supplier_rate_cards r on r.supplier_id = s.id
        where s.name = 'Thandi Web' and r.category_slug = 'wordpress'`,
    );
    expect(row.rows[0]).toEqual({ quality_score: '90.00', fixed: '160000', notes: 'Even better' });
  });

  it('is for owners and operators; a viewer, a non-member and an anonymous caller are refused', async () => {
    const viewer = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_VIEWER),
      payload: { csv: GOOD },
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toBe('your role can view suppliers but not import them');
    const notText = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: 42 },
    });
    expect(notText.statusCode).toBe(422);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      payload: { csv: GOOD },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the list and the export', () => {
  it('lists an organisation’s suppliers with their rate cards, and no other’s', async () => {
    const a = await app.inject({ method: 'GET', url: '/v1/suppliers', headers: as(AUTH_A) });
    expect(a.statusCode).toBe(200);
    const { suppliers } = a.json();
    expect(suppliers.map((s: { name: string }) => s.name)).toEqual(['Studio Nord', 'Thandi Web']);
    expect(suppliers[1]).toMatchObject({
      channel: 'direct',
      languages: ['en', 'zu'],
      qualityScore: '90.00',
      onTimeRate: '0.970',
      paysAfterDelivery: true,
      rateCards: [
        {
          categorySlug: 'wordpress',
          categoryName: 'WordPress',
          currency: 'ZAR',
          fixedPriceMinor: '160000',
          hourlyRateMinor: null,
          turnaroundDays: 4,
        },
        {
          categorySlug: 'seo',
          categoryName: 'SEO',
          currency: 'ZAR',
          fixedPriceMinor: null,
          hourlyRateMinor: '35050',
          turnaroundDays: null,
        },
      ],
    });
    const b = await app.inject({ method: 'GET', url: '/v1/suppliers', headers: as(AUTH_B) });
    expect(b.json().suppliers).toEqual([]);
  });

  it('exports the same columns as the template, and the export imports again unchanged', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/suppliers.csv',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="suppliers-20260923.csv"',
    );
    expect(response.headers['x-export-rows']).toBe('2');
    const lines = response.body.split('\r\n');
    expect(lines[0]).toBe(HEADING);
    expect(lines[1]).toBe('Studio Nord,NO,Europe/Oslo,upwork,en,,,no,,,no,,,,,');
    expect(lines[2]).toBe(
      'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,90.00,0.970,yes,https://example.com/thandi,Even better,yes,wordpress,ZAR,1600.00,,4',
    );
    expect(lines[3]).toBe(
      'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,90.00,0.970,yes,https://example.com/thandi,Even better,yes,seo,ZAR,,350.50,',
    );
    const back = validateSupplierCsv(response.body, { categories: new Set(['wordpress', 'seo']) });
    expect(back.ok).toBe(true);
    const dry = await app.inject({
      method: 'POST',
      url: '/v1/suppliers/import',
      headers: as(AUTH_A),
      payload: { csv: response.body, dryRun: true },
    });
    expect(dry.json()).toMatchObject({ ok: true, suppliers: 2, rateCards: 2 });
  });
});
