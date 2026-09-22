import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  MAX_CITATIONS,
  buildDraftPrompt,
  buildDraftSchema,
  proposalBody,
  splitMilestones,
  type DraftPortfolioItem,
} from './drafting.js';
import type { ScorableJob } from './scoring.js';

/** ARB-043: the rules around the model's words, without a model. Figures are this file's test data. */
const ajv = new Ajv({ strict: false });

const ITEM_A = 'aaaaaaaa-0000-4000-8000-000000000035';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-000000000035';

const valid = {
  body: 'Thanks for the brief. We build WordPress sites for small practices and can rebuild yours in Elementor, keeping your content and improving mobile layout and speed.',
  delivery_days: 10,
  milestones: [
    { title: 'Design', share: 30 },
    { title: 'Build', share: 30 },
    { title: 'Launch', share: 30 },
  ],
  portfolio_item_ids: [ITEM_A],
  operator_notes: '',
};

describe('the draft schema', () => {
  const validate = ajv.compile(buildDraftSchema([ITEM_A, ITEM_B]));

  it('accepts a draft that cites offered items only', () => {
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a citation that was not offered', () => {
    expect(
      validate({ ...valid, portfolio_item_ids: ['cccccccc-0000-4000-8000-000000000035'] }),
    ).toBe(false);
    expect(validate({ ...valid, portfolio_item_ids: [ITEM_A, ITEM_A] })).toBe(false);
    expect(validate({ ...valid, portfolio_item_ids: [ITEM_A, ITEM_B, ITEM_A, ITEM_B] })).toBe(
      false,
    );
    expect(MAX_CITATIONS).toBe(3);
  });

  it('rejects a body with a link in it: links come from the cited items, not the model', () => {
    expect(
      validate({ ...valid, body: `${valid.body} See https://example.com/our-work for more.` }),
    ).toBe(false);
    expect(validate({ ...valid, body: `${valid.body} Also at http://example.com.` })).toBe(false);
  });

  it('allows no citations at all when nothing was offered', () => {
    const none = ajv.compile(buildDraftSchema([]));
    expect(none({ ...valid, portfolio_item_ids: [] })).toBe(true);
    expect(none(valid)).toBe(false);
  });

  it('bounds the milestones and the timeline', () => {
    expect(validate({ ...valid, milestones: [] })).toBe(false);
    expect(
      validate({
        ...valid,
        milestones: Array.from({ length: 6 }, () => ({ title: 'Step', share: 10 })),
      }),
    ).toBe(false);
    expect(validate({ ...valid, milestones: [{ title: 'All', share: 0 }] })).toBe(false);
    expect(validate({ ...valid, delivery_days: 0 })).toBe(false);
    expect(validate({ ...valid, delivery_days: 2.5 })).toBe(false);
    expect(validate({ ...valid, body: 'Too short.' })).toBe(false);
  });
});

describe('splitMilestones', () => {
  it('sums to the price to the cent, with the remainder on the last milestone', () => {
    // R5 000,00 in three equal shares: 1 666,66 + 1 666,66 + 1 666,68.
    const split = splitMilestones(500_000, valid.milestones);
    expect(split.map((m) => m.amount_minor)).toEqual([166_666, 166_666, 166_668]);
    expect(split.reduce((sum, m) => sum + m.amount_minor, 0)).toBe(500_000);
    expect(split[0]).toEqual({ title: 'Design', amount_minor: 166_666, share: 30 });
  });

  it('normalises shares that do not add up to 100', () => {
    // 50/50 of 10,01 → 5,00 and 5,01.
    expect(
      splitMilestones(1_001, [
        { title: 'a', share: 50 },
        { title: 'b', share: 50 },
      ]).map((m) => m.amount_minor),
    ).toEqual([500, 501]);
    // 1/1/1 is the same as 33/33/34, near enough: normalised, the sum still holds.
    const thirds = splitMilestones(100, [
      { title: 'a', share: 1 },
      { title: 'b', share: 1 },
      { title: 'c', share: 1 },
    ]);
    expect(thirds.map((m) => m.amount_minor)).toEqual([33, 33, 34]);
    expect(splitMilestones(999, [{ title: 'all', share: 100 }])[0]?.amount_minor).toBe(999);
  });

  it('refuses a price or shares it cannot split', () => {
    expect(() => splitMilestones(0, valid.milestones)).toThrow(/positive whole amount/);
    expect(() => splitMilestones(10.5, valid.milestones)).toThrow(/positive whole amount/);
    expect(() => splitMilestones(100, [])).toThrow(/at least one milestone/);
    expect(() => splitMilestones(100, [{ title: 'a', share: 0 }])).toThrow(/more than nothing/);
  });
});

describe('the prompt and the body', () => {
  const job: ScorableJob = {
    title: 'Rebuild our WordPress site in Elementor',
    description: 'A 12-page brochure site for a dental practice.',
    budgetMinMinor: 300_000,
    budgetMaxMinor: 500_000,
    currency: 'ZAR',
    hourly: false,
    skills: ['WordPress', 'Elementor'],
    clientCountry: 'ZA',
    clientPaymentVerified: true,
    clientSpendMinor: 1_200_000,
    clientRating: 4.8,
    bidCount: 12,
    averageBidMinor: 400_000,
  };
  const items: DraftPortfolioItem[] = [
    {
      id: ITEM_A,
      title: 'Practice site',
      url: 'https://example.test/practice',
      description: 'A clinic site',
      kind: 'own_work',
    },
    { id: ITEM_B, title: 'Shop demo', url: null, description: null, kind: 'labelled_demo' },
  ];

  it('carries the price and the timeline exactly, the template and the portfolio, and no cost', () => {
    const prompt = buildDraftPrompt({
      job,
      template: { name: 'Web rebuild', body: 'Warm, direct, sign off as the studio.' },
      priceMinor: 500_000,
      currency: 'ZAR',
      deliveryDays: 7,
      portfolio: items,
    });
    expect(prompt).toContain('Price to quote: 5000.00 ZAR. Quote this figure exactly.');
    expect(prompt).toContain('Delivery time: 7 days. Quote this exactly.');
    expect(prompt).toContain('Template "Web rebuild"');
    expect(prompt).toContain('Warm, direct, sign off as the studio.');
    expect(prompt).toContain(`- ${ITEM_A}: Practice site — A clinic site; our own work`);
    expect(prompt).toContain(`- ${ITEM_B}: Shop demo; a demo, to be labelled as such`);
    expect(prompt).not.toMatch(/margin|supplier|cost/i);
    expect(prompt).not.toMatch(/client name|username/i);
  });

  it('asks for a proposed timeline only when the estimate has none, and says the portfolio is empty when it is', () => {
    const prompt = buildDraftPrompt({
      job: { ...job, hourly: true },
      template: { name: 'Hourly', body: 'Brief.' },
      priceMinor: 4_500,
      currency: 'USD',
      deliveryDays: null,
      portfolio: [],
    });
    expect(prompt).toContain('Price to quote: 45.00 USD per hour.');
    expect(prompt).toContain('propose a realistic number of days');
    expect(prompt).toContain('Portfolio items available to cite: none. Cite nothing.');
  });

  it('writes the cited items into the body itself, labelling demos', () => {
    expect(proposalBody('Hello there.  ', items)).toBe(
      'Hello there.\n\nExamples of our work:\n- Practice site: https://example.test/practice\n- Shop demo (demo)',
    );
    expect(proposalBody('Hello there.', [])).toBe('Hello there.');
  });
});
