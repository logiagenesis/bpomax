import { describe, expect, it } from 'vitest';
import { briefFromDiscovery, briefFromModel, briefLockBlockers, validateBrief } from './brief.js';
import { mergeDiscoveryAnswers } from './discovery.js';

const AT = new Date('2026-09-23T10:00:00Z');
const FULL = {
  title: 'Shopify store rebuild',
  outcome: 'A faster shop',
  users: 'Customers',
  mustHaves: ['Checkout', ' Product pages '],
  later: ['Loyalty'],
  references: ['https://example.test'],
  assetsProvided: ['Domain'],
  assetsMissing: ['Brand files'],
  techConstraints: ['Shopify'],
  deadline: '2026-11-30',
  deadlineFixed: false,
  budget: { minMinor: 1500000, maxMinor: 2000000, currency: 'zar', type: 'fixed' },
  acceptanceCriteria: ['Orders go through'],
  signOff: { name: 'Thandi', responseTime: 'same day' },
  risks: [],
  category: 'shopify',
  deliveryRoute: 'in_house',
};

describe('validateBrief', () => {
  it('accepts a full brief, trimming text and upper-casing the currency', () => {
    const result = validateBrief(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mustHaves).toEqual(['Checkout', 'Product pages']);
    expect(result.value.budget).toEqual({
      minMinor: 1500000,
      maxMinor: 2000000,
      currency: 'ZAR',
      type: 'fixed',
    });
    expect(briefLockBlockers(result.value)).toEqual([]);
  });

  it('names each problem: empty title, a bad date, an amount without a currency, a route not in the list', () => {
    const result = validateBrief({
      ...FULL,
      title: ' ',
      deadline: '30/11/2026',
      budget: { minMinor: 100, maxMinor: 50, currency: '', type: 'retainer' },
      deliveryRoute: 'magic',
      mustHaves: ['x', 4],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field).sort()).toEqual(
      [
        'budget.currency',
        'budget.maxMinor',
        'budget.type',
        'deadline',
        'deliveryRoute',
        'mustHaves[1]',
        'title',
      ].sort(),
    );
    expect(result.errors.find((e) => e.field === 'deadline')?.message).toBe(
      'must be a date as YYYY-MM-DD',
    );
  });

  it('a lock needs the category, the route, a must-have and an acceptance criterion', () => {
    const result = validateBrief({ title: 'T', outcome: 'O' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(briefLockBlockers(result.value)).toEqual([
      'a service category',
      'a delivery route',
      'at least one must-have',
      'at least one acceptance criterion',
    ]);
  });
});

describe('drafting', () => {
  it('from the answers alone, each answer lands in its field and nothing is guessed', () => {
    const answers = mergeDiscoveryAnswers(
      {},
      {
        outcome: 'A faster shop',
        users: 'Customers',
        day_one: 'Checkout; product pages. Loyalty can wait.',
        acceptance: 'Orders go through',
        sign_off: 'Thandi, same day',
      },
      'client',
      AT,
    );
    const draft = briefFromDiscovery(answers, 'Shopify store rebuild');
    expect(draft).toMatchObject({
      title: 'Shopify store rebuild',
      outcome: 'A faster shop',
      users: 'Customers',
      mustHaves: ['Checkout; product pages. Loyalty can wait.'],
      acceptanceCriteria: ['Orders go through'],
      signOff: { name: 'Thandi, same day', responseTime: null },
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      deadline: null,
      category: null,
    });
    expect(briefFromDiscovery({}, null).title).toBe('Brief');
  });

  it('the model’s structure is laid over the hand draft; amounts become minor units, only with a currency', () => {
    const base = briefFromDiscovery({}, 'Job');
    const built = briefFromModel(
      {
        outcome: 'A faster shop',
        users: null,
        must_haves: ['Checkout', 'Product pages'],
        later: ['Loyalty'],
        references: [],
        assets_provided: [],
        assets_missing: ['Brand files'],
        tech_constraints: [],
        deadline: '2026-11-30',
        deadline_fixed: false,
        // Hand-worked: R15 000 and R20 000 are 1 500 000 and 2 000 000 cents.
        budget: { min: 15000, max: 20000, currency: 'ZAR', type: 'fixed' },
        acceptance_criteria: ['Orders go through'],
        sign_off: { name: 'Thandi', response_time: 'same day' },
        risks: ['Brand files are missing'],
      },
      base,
    );
    expect(built.budget).toEqual({
      minMinor: 1500000,
      maxMinor: 2000000,
      currency: 'ZAR',
      type: 'fixed',
    });
    expect(built.mustHaves).toEqual(['Checkout', 'Product pages']);
    expect(built.later).toEqual(['Loyalty']);
    const noCurrency = briefFromModel(
      {
        outcome: 'x',
        users: null,
        must_haves: [],
        later: [],
        references: [],
        assets_provided: [],
        assets_missing: [],
        tech_constraints: [],
        deadline: null,
        deadline_fixed: null,
        budget: { min: 100, max: null, currency: null, type: null },
        acceptance_criteria: [],
        sign_off: { name: null, response_time: null },
        risks: [],
      },
      base,
    );
    expect(noCurrency.budget).toEqual({
      minMinor: null,
      maxMinor: null,
      currency: null,
      type: null,
    });
  });
});
