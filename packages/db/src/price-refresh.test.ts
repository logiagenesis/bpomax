import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from './fixtures.js';
import { refreshPriceBands } from './price-refresh.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-514: market bands from completed projects. The house org (a) has accepted
 * deliveries; a customer org (b) has more, which must never reach the shared bands. Every
 * cost is a test figure, not a market price (D-14).
 */
let db: PGlite;
const HOUSE = fixtureId('a', ENTITY.org);
const CUSTOMER = fixtureId('b', ENTITY.org);
/** 26/09/2026 10:00 UTC. The look-back reaches 26/09/2025. */
const NOW = new Date('2026-09-26T10:00:00Z');
const RECENT = '2026-08-01T08:00:00Z';
let serial = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.query(`update orgs set billing_exempt = false where id = $1`, [CUSTOMER]);
  await db.exec(`insert into service_categories (slug, name) values
    ('seo', 'SEO'), ('logo', 'Logo design') on conflict do nothing`);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function supplier(org: string, channel: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into suppliers (org_id, name, channel) values ($1, $2, $3) returning id`,
    [org, `${channel} supplier ${String(++serial)}`, channel],
  );
  return rows[0]!.id;
}

/** One delivery at `costMinor`, accepted at `acceptedAt`, on a job in `category`. */
async function delivery(input: {
  org?: string;
  category: string | null;
  costMinor: number;
  currency?: string;
  acceptedAt?: string;
  status?: string;
  hourly?: boolean;
  supplierId?: string | null;
}): Promise<void> {
  const org = input.org ?? HOUSE;
  const n = String(++serial);
  const job = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, currency, hourly, category_slug)
     values ($1, 'freelancer', $2, '{}'::jsonb, 'A job', 'ZAR', $3, $4) returning id`,
    [org, `job-${n}`, input.hourly ?? false, input.category],
  );
  const item = await db.query<{ id: string }>(
    `insert into pipeline_items (org_id, job_id, stage) values ($1, $2, 'delivered') returning id`,
    [org, job.rows[0]!.id],
  );
  await db.query(
    `insert into delivery_orders
       (org_id, pipeline_item_id, supplier_id, status, agreed_cost_minor, currency, milestones, accepted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      org,
      item.rows[0]!.id,
      input.supplierId ?? null,
      input.status ?? 'accepted',
      input.costMinor,
      input.currency ?? 'ZAR',
      JSON.stringify([{ title: 'All of it', amountMinor: input.costMinor }]),
      input.acceptedAt ?? RECENT,
    ],
  );
}

/** The completed-projects bands, or every band (the reference rows add a web-design seed). */
async function bands(all = false): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select category_slug, currency, p25_minor::text as p25, p50_minor::text as p50,
            p75_minor::text as p75, sample_size, source::text as source
       from market_price_bands where $1 or source = 'completed_projects'
      order by category_slug, currency, source`,
    [all],
  );
  return rows;
}

describe('refreshPriceBands', () => {
  it('makes a band from five or more of the house org s accepted deliveries, and none from fewer', async () => {
    // SEO in rand: 1 000, 2 000, 3 000, 4 000, 10 000. Quartiles at positions 1, 2, 3.
    for (const cost of [100_000, 200_000, 300_000, 400_000, 1_000_000]) {
      await delivery({ category: 'seo', costMinor: cost });
    }
    // Four logos: too few.
    for (const cost of [50_000, 60_000, 70_000, 80_000]) {
      await delivery({ category: 'logo', costMinor: cost });
    }
    const result = await refreshPriceBands(db, { now: NOW });
    expect(result.refreshed).toEqual([
      {
        categorySlug: 'seo',
        currency: 'ZAR',
        sampleSize: 5,
        p25Minor: '200000',
        p50Minor: '300000',
        p75Minor: '400000',
      },
    ]);
    expect(result.tooFew).toEqual([{ categorySlug: 'logo', currency: 'ZAR', sampleSize: 4 }]);
    expect(await bands()).toEqual([
      {
        category_slug: 'seo',
        currency: 'ZAR',
        p25: '200000',
        p50: '300000',
        p75: '400000',
        sample_size: 5,
        source: 'completed_projects',
      },
    ]);
  });

  it('never reads another org s deliveries, nor what is not a market price', async () => {
    // A customer's cheap SEO work: five deliveries that would drag the median down.
    for (let i = 0; i < 5; i += 1) {
      await delivery({ org: CUSTOMER, category: 'seo', costMinor: 1_000 });
    }
    // In the house org, none of these is a sample.
    const inHouse = await supplier(HOUSE, 'in_house');
    const aiBuild = await supplier(HOUSE, 'ai_build');
    await delivery({ category: 'seo', costMinor: 1, supplierId: inHouse });
    await delivery({ category: 'seo', costMinor: 1, supplierId: aiBuild });
    await delivery({ category: 'seo', costMinor: 1, hourly: true });
    await delivery({ category: 'seo', costMinor: 1, status: 'delivered' });
    await delivery({ category: 'seo', costMinor: 1, acceptedAt: '2025-09-01T08:00:00Z' });
    await delivery({ category: null, costMinor: 1 });

    await refreshPriceBands(db, { now: NOW });
    expect(await bands()).toEqual([
      expect.objectContaining({ category_slug: 'seo', p50: '300000', sample_size: 5 }),
    ]);
  });

  it('counts an outside supplier s delivery, and a sixth sample moves the band', async () => {
    const outside = await supplier(HOUSE, 'freelancer');
    await delivery({ category: 'seo', costMinor: 500_000, supplierId: outside });
    const result = await refreshPriceBands(db, { now: NOW });
    // 1 000, 2 000, 3 000, 4 000, 5 000, 10 000: positions 1,25; 2,5; 3,75.
    // p25 = 2 000 + 0,25 × 1 000 = 2 250; p50 = 3 500; p75 = 4 000 + 0,75 × 1 000 = 4 750.
    expect(result.refreshed[0]).toMatchObject({
      sampleSize: 6,
      p25Minor: '225000',
      p50Minor: '350000',
      p75Minor: '475000',
    });
  });

  it('leaves seed and CSV bands alone, and removes a completed-projects band that lost its samples', async () => {
    await db.exec(`insert into market_price_bands
      (category_slug, currency, p25_minor, p50_minor, p75_minor, sample_size, source)
      values ('logo', 'ZAR', 1, 2, 3, 0, 'seed'), ('logo', 'ZAR', 4, 5, 6, 10, 'owner_csv')`);
    // A year on, every SEO delivery is outside the look-back.
    const later = new Date('2027-09-26T10:00:00Z');
    const result = await refreshPriceBands(db, { now: later });
    expect(result.refreshed).toEqual([]);
    expect(result.removed).toBe(1);
    expect(
      (await bands(true)).map((b) => `${String(b.category_slug)} ${String(b.source)}`),
    ).toEqual(['logo owner_csv', 'logo seed', 'web-design seed']);
  });

  it('records each run in the house org s audit log, not the customer s', async () => {
    const { rows } = await db.query<{ org_id: string; outcome: string; payload: unknown }>(
      `select org_id, outcome::text as outcome, payload from events
        where type = 'price_bands.refreshed' order by created_at`,
    );
    expect(rows.map((r) => r.org_id)).toEqual([HOUSE, HOUSE, HOUSE, HOUSE]);
    expect(rows[0]).toMatchObject({
      outcome: 'ok',
      payload: {
        bands: [{ category: 'seo', currency: 'ZAR', sampleSize: 5, p50Minor: '300000' }],
        tooFew: [{ categorySlug: 'logo', currency: 'ZAR', sampleSize: 4 }],
        removed: 0,
        minSample: 5,
        lookbackDays: 365,
      },
    });
    expect(rows[3]).toMatchObject({ outcome: 'ok', payload: { bands: [], removed: 1 } });
  });
});
