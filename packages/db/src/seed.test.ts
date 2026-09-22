import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSeedSql, loadMarketPriceBands, loadServiceCategories } from './seed.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-013 acceptance: the seed is idempotent, and seed bands are flagged as seed.
 *
 * The slug list is not copied from the spec into a test — it is parsed out of the spec,
 * so a category added to docs/01 and forgotten here fails the build rather than quietly
 * never existing.
 */
let db: PGlite;

const SPEC = fileURLToPath(new URL('../../../docs/01-MASTER-BUILD-PROMPT.md', import.meta.url));

/** The slugs docs/01 section D names, read from the document itself. */
function specSlugs(): string[] {
  const spec = readFileSync(SPEC, 'utf8');
  const match = spec.match(/Seed `service_categories` with:\s*([^.]+)\./);
  if (!match?.[1]) throw new Error('docs/01 no longer states the service_categories seed list');
  return match[1]
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('the seed', () => {
  it('carries exactly the categories the spec names, in the spec s order', () => {
    expect(loadServiceCategories().map((c) => c.slug)).toEqual(specSlugs());
  });

  it('gives every category a display name and leaves in_house to the owner', () => {
    for (const category of loadServiceCategories()) {
      expect(category.name.trim().length).toBeGreaterThan(0);
      expect(category.inHouse ?? false).toBe(false);
    }
  });

  it('applies, and applies again without changing anything', async () => {
    await db.exec(buildSeedSql());

    const first = await db.query<{ slug: string; name: string; sort_order: number }>(
      'select slug, name, sort_order from service_categories order by sort_order',
    );
    expect(first.rows.map((r) => r.slug)).toEqual(specSlugs());

    await db.exec(buildSeedSql());

    const second = await db.query<{ slug: string; name: string; sort_order: number }>(
      'select slug, name, sort_order from service_categories order by sort_order',
    );
    expect(second.rows).toEqual(first.rows);

    const bands = await db.query<{ count: number }>(
      'select count(*)::int as count from market_price_bands',
    );
    expect(bands.rows[0]?.count).toBe(loadMarketPriceBands().length);
  });

  it('does not untick a category the owner has ticked', async () => {
    await db.exec(`update service_categories set in_house = true where slug = 'website-build'`);
    await db.exec(buildSeedSql());

    const { rows } = await db.query<{ in_house: boolean }>(
      `select in_house from service_categories where slug = 'website-build'`,
    );
    expect(rows[0]?.in_house).toBe(true);
  });

  it('flags every band it writes as a seed, never as an observation', async () => {
    // The shipped set is empty on purpose (packages/db/seed/README.md), so the rule is
    // proven against a band put through the same generator.
    const sql = buildSeedSql().replace(
      'commit;',
      `insert into market_price_bands (category_slug, currency, p25_minor, p50_minor, p75_minor, sample_size, source)
       values ('seo', 'ZAR', 100000, 200000, 300000, 0, 'seed')
       on conflict (category_slug, currency, source) do nothing;
       commit;`,
    );
    await db.exec(sql);

    const { rows } = await db.query<{ source: string }>('select source from market_price_bands');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.source).toBe('seed');
  });

  it('ships no invented price figures', () => {
    // ARB-040 prices real bids off the p50. A band that came from nowhere would become a
    // number on a real proposal, so the shipped seed carries none (docs/BLOCKERS.md D-14).
    expect(loadMarketPriceBands()).toEqual([]);
  });
});
