import { describe, expect, it } from 'vitest';
import { aggregateAnalytics, analyticsTotal, ratio, type JobFacts } from './analytics.js';

/**
 * ARB-320: every figure hand-worked beside it. Five jobs with a submitted bid:
 *
 *   J1  Web design  Short  Thandi   Shopify scan  replied  won   in R15 000,00 out R10 500,50  USD 0,003 of model
 *   J2  Web design  Short  —        Shopify scan  replied  lost                               USD 0,001
 *   J3  Web design  Long   —        SEO scan                                                   USD 0,0005
 *   J4  —           Long   —        —             replied        one USD payment unconverted  USD 0,00025
 *   J5  SEO         —      Thandi   SEO scan               won   in R4 000,00 out R1 000,00
 */
const job = (id: string, fields: Partial<JobFacts>): JobFacts => ({
  jobId: id,
  categoryKey: null,
  categoryLabel: null,
  templateKey: null,
  templateLabel: null,
  supplierKey: null,
  supplierLabel: null,
  scannerKey: null,
  scannerLabel: null,
  replied: false,
  won: false,
  lost: false,
  inZarMinor: '0',
  outZarMinor: '0',
  unconvertedPayments: 0,
  modelCostNanoUsd: '0',
  ...fields,
});
const web = { categoryKey: 'web-design', categoryLabel: 'Web design' };
const short = { templateKey: 't1', templateLabel: 'Short' };
const long = { templateKey: 't2', templateLabel: 'Long' };
const thandi = { supplierKey: 's1', supplierLabel: 'Thandi' };
const shopifyScan = { scannerKey: 'sc1', scannerLabel: 'Shopify scan' };
const seoScan = { scannerKey: 'sc2', scannerLabel: 'SEO scan' };
const FACTS = [
  job('J1', {
    ...web,
    ...short,
    ...thandi,
    ...shopifyScan,
    replied: true,
    won: true,
    inZarMinor: '1500000',
    outZarMinor: '1050050',
    modelCostNanoUsd: '3000000',
  }),
  job('J2', {
    ...web,
    ...short,
    ...shopifyScan,
    replied: true,
    lost: true,
    modelCostNanoUsd: '1000000',
  }),
  job('J3', { ...web, ...long, ...seoScan, modelCostNanoUsd: '500000' }),
  job('J4', { ...long, replied: true, unconvertedPayments: 1, modelCostNanoUsd: '250000' }),
  job('J5', {
    categoryKey: 'seo',
    categoryLabel: 'SEO',
    ...thandi,
    ...seoScan,
    won: true,
    inZarMinor: '400000',
    outZarMinor: '100000',
  }),
];

describe('ratio', () => {
  it('is a percentage to one decimal, half up, and no data with nothing under it', () => {
    expect(ratio(2, 3)).toEqual({ numerator: 2, denominator: 3, percent: '66.7' }); // 66,66…
    expect(ratio(1, 3).percent).toBe('33.3');
    expect(ratio(1, 8).percent).toBe('12.5');
    expect(ratio(1, 16).percent).toBe('6.3'); // 6,25 → 6,3 (half up)
    expect(ratio(0, 4).percent).toBe('0.0');
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, percent: null });
  });
});

describe('aggregateAnalytics', () => {
  it('by category', () => {
    const rows = aggregateAnalytics(FACTS, 'category');
    expect(rows.map((r) => r.label)).toEqual(['Web design', 'Not classified', 'SEO']);
    // Web design: 3 bids, 2 replies (66,7 %), 1 won of 2 decided (50,0 %),
    // margin R15 000,00 − R10 500,50 = R4 499,50; model USD 0,0045 ÷ 2 replies = USD 0,00225.
    expect(rows[0]).toEqual({
      key: 'web-design',
      label: 'Web design',
      bids: 3,
      replies: 2,
      replyRate: { numerator: 2, denominator: 3, percent: '66.7' },
      won: 1,
      lost: 1,
      winRate: { numerator: 1, denominator: 2, percent: '50.0' },
      realisedMarginZarMinor: '449950',
      unconvertedPayments: 0,
      modelCostNanoUsd: '4500000',
      costPerReplyNanoUsd: '2250000',
    });
    // Not classified: nothing decided, so the win rate is no data; its payment unconverted.
    expect(rows[1]).toMatchObject({
      key: null,
      replyRate: { percent: '100.0' },
      winRate: { percent: null },
      unconvertedPayments: 1,
      costPerReplyNanoUsd: '250000',
    });
    // SEO: no reply, so no cost per reply; won 1 of 1; margin R3 000,00.
    expect(rows[2]).toMatchObject({
      replyRate: { percent: '0.0' },
      winRate: { percent: '100.0' },
      realisedMarginZarMinor: '300000',
      costPerReplyNanoUsd: null,
    });
  });

  it('by template, supplier and scanner, the same jobs regrouped', () => {
    expect(
      aggregateAnalytics(FACTS, 'template').map((r) => [r.label, r.bids, r.replyRate.percent]),
    ).toEqual([
      ['Long', 2, '50.0'],
      ['Short', 2, '100.0'],
      ['No template', 1, '0.0'],
    ]);
    const suppliers = aggregateAnalytics(FACTS, 'supplier');
    // Thandi: J1 + J5, margin R4 499,50 + R3 000,00 = R7 499,50, won 2 of 2.
    expect(
      suppliers.map((r) => [r.label, r.bids, r.winRate.percent, r.realisedMarginZarMinor]),
    ).toEqual([
      ['No supplier', 3, '0.0', '0'],
      ['Thandi', 2, '100.0', '749950'],
    ]);
    expect(
      aggregateAnalytics(FACTS, 'scanner').map((r) => [r.label, r.bids, r.modelCostNanoUsd]),
    ).toEqual([
      ['SEO scan', 2, '500000'],
      ['Shopify scan', 2, '4000000'],
      ['No scanner', 1, '250000'],
    ]);
  });

  it('the total is every bid together; no bids is an empty list and no data', () => {
    // 5 bids, 3 replies (60,0 %), 2 won of 3 decided (66,7 %), margin R7 499,50,
    // model USD 0,00475 ÷ 3 replies = 1 583 333,33… → 1 583 333 nano-USD.
    expect(analyticsTotal(FACTS)).toMatchObject({
      label: 'All bids',
      bids: 5,
      replyRate: { percent: '60.0' },
      winRate: { percent: '66.7' },
      realisedMarginZarMinor: '749950',
      modelCostNanoUsd: '4750000',
      costPerReplyNanoUsd: '1583333',
    });
    expect(aggregateAnalytics([], 'category')).toEqual([]);
    expect(analyticsTotal([])).toMatchObject({ bids: 0, replyRate: { percent: null } });
  });
});
