import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  AI_BUILD_CATEGORIES,
  BAND_SOURCE_PRIORITY,
  buildCategorySchema,
  buildClassifyPrompt,
  chooseEstimate,
  medianMinor,
  type EstimateInputs,
  type PriceBandSource,
  type RateCardSource,
} from './estimating.js';

/** ARB-040: the method order and the arithmetic, without a database or a model. */

function card(fields: Partial<RateCardSource> & { supplierId: string }): RateCardSource {
  return {
    supplierName: `Supplier ${fields.supplierId}`,
    channel: 'direct',
    currency: 'ZAR',
    fixedPriceMinor: null,
    hourlyRateMinor: null,
    turnaroundDays: null,
    ...fields,
  };
}

function band(fields: Partial<PriceBandSource> & { id: string }): PriceBandSource {
  return {
    currency: 'ZAR',
    p25Minor: 100_00,
    p50Minor: 200_00,
    p75Minor: 400_00,
    sampleSize: 10,
    source: 'owner_csv',
    sampledAt: '2026-09-01T00:00:00.000Z',
    ...fields,
  };
}

function inputs(fields: Partial<EstimateInputs> = {}): EstimateInputs {
  return {
    category: { slug: 'copywriting', inHouse: false },
    currency: 'ZAR',
    hourly: false,
    rateCards: [],
    bands: [],
    ...fields,
  };
}

describe('medianMinor', () => {
  it('takes the middle value of an odd count', () => {
    // 300, 500, 900 → 500
    expect(medianMinor([900_00, 300_00, 500_00])).toBe(500_00);
  });

  it('averages the two middle values of an even count, rounded down to whole minor units', () => {
    // 300.00 and 500.01 → 400.005, which is 400.00 in whole cents
    expect(medianMinor([500_01, 300_00])).toBe(400_00);
    expect(medianMinor([1, 2])).toBe(1);
  });

  it('refuses an empty list rather than answering NaN', () => {
    expect(() => medianMinor([])).toThrow(/at least one value/);
  });
});

describe('chooseEstimate: the order of methods', () => {
  const inHouseCard = card({
    supplierId: 'ih',
    channel: 'in_house',
    fixedPriceMinor: 250_000,
    turnaroundDays: 5,
  });
  const directCard = card({ supplierId: 'd1', fixedPriceMinor: 500_000, turnaroundDays: 7 });
  const aiCard = card({ supplierId: 'ai', channel: 'ai_build', fixedPriceMinor: 80_000 });

  it('prefers in-house when the category is in-house and an in-house rate exists', () => {
    const decision = chooseEstimate(
      inputs({
        category: { slug: 'website-build', inHouse: true },
        rateCards: [directCard, inHouseCard, aiCard],
        bands: [band({ id: 'b' })],
      }),
    );
    expect(decision.choice).toMatchObject({
      method: 'in_house',
      lowMinor: 250_000,
      expectedMinor: 250_000,
      highMinor: 250_000,
      turnaroundDays: 5,
      supplierId: 'ih',
    });
    expect(decision.considered).toEqual([]);
  });

  it('skips in-house when the category is not ticked in-house, even with an in-house rate', () => {
    const decision = chooseEstimate(
      inputs({
        category: { slug: 'website-build', inHouse: false },
        rateCards: [inHouseCard, directCard],
      }),
    );
    expect(decision.choice?.method).toBe('rate_card');
    expect(decision.considered[0]).toMatch(/in_house: category is not delivered in-house/);
  });

  it('falls from an in-house category without a rate to the suppliers', () => {
    const decision = chooseEstimate(
      inputs({ category: { slug: 'website-build', inHouse: true }, rateCards: [directCard] }),
    );
    expect(decision.choice?.method).toBe('rate_card');
    expect(decision.considered[0]).toMatch(/in_house: no active supplier has a ZAR fixed price/);
  });

  it('spreads several supplier cards as min, median and max, with the median turnaround', () => {
    // Hand-worked: prices 300 000, 500 000 and 900 000 → low 300 000, expected 500 000,
    // high 900 000; turnarounds 3, 7, 10 → 7 days.
    const decision = chooseEstimate(
      inputs({
        rateCards: [
          card({ supplierId: 'a', fixedPriceMinor: 900_000, turnaroundDays: 10 }),
          card({ supplierId: 'b', fixedPriceMinor: 300_000, turnaroundDays: 3 }),
          card({ supplierId: 'c', channel: 'fiverr', fixedPriceMinor: 500_000, turnaroundDays: 7 }),
        ],
      }),
    );
    expect(decision.choice).toMatchObject({
      method: 'rate_card',
      lowMinor: 300_000,
      expectedMinor: 500_000,
      highMinor: 900_000,
      turnaroundDays: 7,
      supplierId: null,
    });
    expect(decision.choice?.basis).toMatchObject({
      priced: 'fixed',
      suppliers: expect.arrayContaining([
        expect.objectContaining({ id: 'c', channel: 'fiverr', priceMinor: 500_000 }),
      ]) as unknown,
    });
  });

  it('uses the market band when no supplier has a rate', () => {
    const decision = chooseEstimate(
      inputs({
        bands: [band({ id: 'b1', p25Minor: 150_000, p50Minor: 300_000, p75Minor: 600_000 })],
      }),
    );
    expect(decision.choice).toMatchObject({
      method: 'market_band',
      lowMinor: 150_000,
      expectedMinor: 300_000,
      highMinor: 600_000,
      turnaroundDays: null,
      supplierId: null,
      basis: { bandId: 'b1', source: 'owner_csv', isSeed: false, sampleSize: 10 },
    });
    expect(decision.considered).toHaveLength(2);
  });

  it('prefers an observed band to a seed band, and a newer band to an older one of the same source', () => {
    const older = band({ id: 'old', source: 'owner_csv', sampledAt: '2026-01-01T00:00:00.000Z' });
    const newer = band({ id: 'new', source: 'owner_csv', sampledAt: '2026-06-01T00:00:00.000Z' });
    const seed = band({ id: 'seed', source: 'seed', sampledAt: '2026-09-01T00:00:00.000Z' });
    expect(chooseEstimate(inputs({ bands: [seed, older, newer] })).choice?.basis).toMatchObject({
      bandId: 'new',
    });
    expect(chooseEstimate(inputs({ bands: [seed] })).choice?.basis).toMatchObject({
      bandId: 'seed',
      isSeed: true,
    });
    expect(BAND_SOURCE_PRIORITY[BAND_SOURCE_PRIORITY.length - 1]).toBe('seed');
  });

  it('offers the AI-build tier last, and only for website categories', () => {
    const website = chooseEstimate(
      inputs({ category: { slug: 'landing-page', inHouse: false }, rateCards: [aiCard] }),
    );
    expect(website.choice).toMatchObject({
      method: 'ai_build',
      expectedMinor: 80_000,
      supplierId: 'ai',
    });

    const content = chooseEstimate(inputs({ rateCards: [aiCard] }));
    expect(content.choice).toBeNull();
    expect(content.considered.at(-1)).toMatch(/only website categories/);
    for (const slug of AI_BUILD_CATEGORIES)
      expect(slug).toMatch(/website|wordpress|elementor|shopify|landing/);
  });

  it('returns no choice, and says why for every method, when there is nothing to stand on', () => {
    const decision = chooseEstimate(inputs({ category: { slug: 'website-build', inHouse: true } }));
    expect(decision.choice).toBeNull();
    expect(decision.considered).toEqual([
      expect.stringMatching(/^in_house: /),
      expect.stringMatching(/^rate_card: /),
      expect.stringMatching(/^market_band: .*D-14/),
      expect.stringMatching(/^ai_build: /),
    ]);
  });
});

describe('chooseEstimate: hourly jobs and currencies', () => {
  it('prices an hourly job from hourly rates only, and never from a band', () => {
    const decision = chooseEstimate(
      inputs({
        hourly: true,
        rateCards: [
          card({ supplierId: 'fixed-only', fixedPriceMinor: 500_000 }),
          card({ supplierId: 'hourly', hourlyRateMinor: 45_00, turnaroundDays: 1 }),
        ],
        bands: [band({ id: 'b' })],
      }),
    );
    expect(decision.choice).toMatchObject({
      method: 'rate_card',
      lowMinor: 45_00,
      expectedMinor: 45_00,
      highMinor: 45_00,
      supplierId: 'hourly',
      basis: { priced: 'per_hour' },
    });

    const bandOnly = chooseEstimate(inputs({ hourly: true, bands: [band({ id: 'b' })] }));
    expect(bandOnly.choice).toBeNull();
    expect(bandOnly.considered).toContainEqual(expect.stringMatching(/hourly job cannot use them/));
  });

  it('reads only sources in the job s currency; conversion is not its job', () => {
    const decision = chooseEstimate(
      inputs({
        currency: 'USD',
        rateCards: [card({ supplierId: 'zar', fixedPriceMinor: 500_000 })],
        bands: [band({ id: 'zar-band' })],
      }),
    );
    expect(decision.choice).toBeNull();
    expect(decision.considered).toContainEqual(expect.stringMatching(/USD fixed price/));
    expect(decision.considered).toContainEqual(expect.stringMatching(/no USD band/));
  });
});

describe('classification', () => {
  const slugs = ['website-build', 'copywriting'];
  const validate = new Ajv({ strict: false }).compile(buildCategorySchema(slugs));

  it('holds the model to the taxonomy: a slug it made up is rejected, null is allowed', () => {
    expect(validate({ category_slug: 'copywriting', confidence: 0.8, reason: 'Blog posts.' })).toBe(
      true,
    );
    expect(validate({ category_slug: null, confidence: 0.2, reason: 'Nothing fits.' })).toBe(true);
    expect(validate({ category_slug: 'blogging', confidence: 0.8, reason: 'Blog posts.' })).toBe(
      false,
    );
    expect(validate({ category_slug: 'copywriting', confidence: 1.5, reason: 'x' })).toBe(false);
    expect(validate({ category_slug: 'copywriting', confidence: 0.5 })).toBe(false);
  });

  it('puts the job and the taxonomy in the prompt, and nothing about the client', () => {
    const prompt = buildClassifyPrompt(
      {
        title: 'Write 10 blog posts',
        description: 'About dental hygiene.',
        skills: ['SEO writing'],
      },
      [
        { slug: 'website-build', name: 'Website build' },
        { slug: 'copywriting', name: 'Copywriting' },
      ],
    );
    expect(prompt).toContain('Write 10 blog posts');
    expect(prompt).toContain('- copywriting: Copywriting');
    expect(prompt).toContain('SEO writing');
    expect(prompt).not.toMatch(/client (name|country|rating)/i);
  });
});
