import { describe, expect, it } from 'vitest';
import type { Project } from './freelancer.js';
import {
  PLACEHOLDERS,
  buildProposal,
  firstLine,
  openingPrice,
  unfilledMessage,
  unfilledPlaceholders,
  type Template,
} from './proposal.js';
import { formatPrice } from './text.js';
import { bidsThisMonth, logEntry, sastMonth, type LogEntry } from './tracker.js';

/** The proposal, the price rule and the bid log (LI-PROMPT-BPOMAX-RADAR-20260927, 4.3–4.4). */
const NBSP = ' ';
const NOW = Date.parse('2026-09-27T06:53:14Z');

function project(over: Partial<Project> = {}): Project {
  return {
    id: 40735834,
    title: 'Recruiter for Interviews',
    description:
      'We need a recruiter to book interviews. The work is remote!\nPlease send examples.',
    url: 'https://www.freelancer.com/projects/article-writing/Recruiter-for-Interviews',
    type: 'fixed',
    currency: 'USD',
    usdRate: 1,
    budgetMin: 250,
    budgetMax: 750,
    bidCount: 2,
    bidAvg: 375,
    submitted: NOW - 20 * 60_000,
    skills: [
      { id: 3, name: 'PHP' },
      { id: 17, name: 'WordPress' },
      { id: 99, name: 'Recruitment' },
    ],
    upgrades: { nda: false, sealed: false, urgent: false, featured: false },
    ...over,
  };
}

const template = (body: string): Template => ({ id: 't1', name: 'Plain', body, isDefault: true });
const settings = {
  inHouse: [
    { id: 17, name: 'WordPress' },
    { id: 3, name: 'PHP' },
  ],
};

describe('the opening price', () => {
  it('is the maximum times the percentage: 60 % of USD 750 is 450', () => {
    expect(openingPrice(project(), 60)).toBe(450);
  });

  it('never goes under the project’s minimum: 20 % of 750 is 150, raised to 250', () => {
    expect(openingPrice(project(), 20)).toBe(250);
  });

  it('never goes over its maximum', () => {
    expect(openingPrice(project(), 100)).toBe(750);
  });

  it('is a whole number in the project’s own currency: 60 % of INR 12 500 is 7 500', () => {
    expect(openingPrice(project({ currency: 'INR', budgetMin: 1500, budgetMax: 12500 }), 60)).toBe(
      7500,
    );
    // 60 % of AUD 25 is 15; 60 % of AUD 33 is 19,8 → 20.
    expect(openingPrice(project({ currency: 'AUD', budgetMin: 15, budgetMax: 33 }), 60)).toBe(20);
  });

  it('rounds inside the range when the ends are not whole', () => {
    expect(openingPrice(project({ budgetMin: 10.6, budgetMax: 12 }), 10)).toBe(11);
  });

  it('uses the one end given, and nothing without a budget', () => {
    expect(openingPrice(project({ budgetMax: null, budgetMin: 30 }), 60)).toBe(30);
    expect(openingPrice(project({ budgetMin: null, budgetMax: null }), 60)).toBeNull();
  });
});

describe('the first line of the client’s description', () => {
  it('is its first sentence', () => {
    expect(firstLine(project().description)).toBe('We need a recruiter to book interviews.');
    expect(firstLine('Urgent! Fix my site')).toBe('Urgent!');
    expect(firstLine('Version 2.5 needs work. Soon')).toBe('Version 2.5 needs work.');
  });

  it('stops at a line break', () => {
    expect(firstLine('  Logo for a bakery\nColours: blue')).toBe('Logo for a bakery');
  });

  it('is left whole at 160 characters or fewer', () => {
    // 15 words of 9 letters and a space (150 characters), then a 9-letter word and the stop:
    // 150 + 9 + 1 = 160 characters exactly.
    const exact = `${'abcdefghi '.repeat(15)}abcdefghi.`;
    expect(exact).toHaveLength(160);
    expect(firstLine(exact)).toBe(exact);
  });

  it('over 160 characters is cut at the last whole word and ends with …', () => {
    // "abcdefghi " × 15 is 150 characters (indices 0–149). The next word, 0123456789ABCDEF,
    // fills indices 150–165, so the 160th character is inside it. The last space before it
    // is index 149, so the cut keeps 14 words + "abcdefghi" (149 characters) and adds "…".
    const long = `${'abcdefghi '.repeat(15)}0123456789ABCDEF and more.`;
    const cut = firstLine(long);
    expect(cut).toBe(`${'abcdefghi '.repeat(14)}abcdefghi…`);
    expect(cut).toHaveLength(150);
    expect(cut).not.toContain('0123456789ABCDEF');
  });

  it('is at most 161 characters: 160 of whole words, then …', () => {
    // 15 words of 9 letters + a space (150), then a 10-letter word (indices 150–159) and a
    // space at index 160: the cut falls exactly between words and keeps all 160 characters
    // of the first 16 words, plus …
    const long = `${'abcdefghi '.repeat(15)}abcdefghij and then some more words after it.`;
    const cut = firstLine(long);
    expect(cut).toBe(`${'abcdefghi '.repeat(15)}abcdefghij…`);
    expect(cut).toHaveLength(161);
  });

  it('never keeps a comma or dash in front of the …', () => {
    // "abcdefghi " × 14 (140), "abcdefghi," (140–149), a space at 150, then 18 z's.
    const long = `${'abcdefghi '.repeat(14)}abcdefghi, ${'z'.repeat(18)} end.`;
    expect(firstLine(long)).toBe(`${'abcdefghi '.repeat(14)}abcdefghi…`);
  });

  it('cuts a single word longer than 160 characters at 160, since it has no boundary', () => {
    const cut = firstLine(`${'a'.repeat(200)}.`);
    expect(cut).toBe(`${'a'.repeat(160)}…`);
    expect(cut).toHaveLength(161);
  });

  it('never ends on half of an emoji', () => {
    // 159 letters, then 😀 (two UTF-16 units, indices 159–160): the 160-unit cut would end
    // on its first half, which is dropped.
    const cut = firstLine(`${'a'.repeat(159)}😀${'b'.repeat(20)}.`);
    expect(cut).toBe(`${'a'.repeat(159)}…`);
  });
});

describe('placeholders left in a text (R-01)', () => {
  it('lists each one still there, once, in the order they first appear', () => {
    expect(unfilledPlaceholders('Skills: {skills}. Then {made_up}, and {skills} again.')).toEqual([
      '{skills}',
      '{made_up}',
    ]);
  });

  it('returns none for a clean text', () => {
    expect(unfilledPlaceholders('Hello. I can do this for USD 450 in 7 days.')).toEqual([]);
    expect(unfilledPlaceholders('')).toEqual([]);
  });

  it('counts a mistyped placeholder too: another case, a hyphen, spaces inside', () => {
    expect(unfilledPlaceholders('{Title} {first-line} { price } {timeline_days}')).toEqual([
      '{Title}',
      '{first-line}',
      '{price}',
      '{timeline_days}',
    ]);
  });

  it('leaves braces that are not a name alone: empty, code, numbers', () => {
    expect(unfilledPlaceholders('{} { } a { color: red; } {1} {"a": 1}')).toEqual([]);
  });

  it('finds what buildProposal could not fill: {skills} with no in-house overlap', () => {
    const job = { ...project(), price: 450, days: 7 };
    const withOverlap = buildProposal(job, template('Skills: {skills}. {price}'), settings);
    expect(unfilledPlaceholders(withOverlap)).toEqual([]);

    const noOverlap = buildProposal(job, template('Skills: {skills}. {made_up} {price}'), {
      inHouse: [{ id: 555 }], // a skill none of the project's three skills matches
    });
    expect(noOverlap).toBe('Skills: {skills}. {made_up} USD 450');
    expect(unfilledPlaceholders(noOverlap)).toEqual(['{skills}', '{made_up}']);

    const noInHouse = buildProposal(job, template('Skills: {skills}'), { inHouse: [] });
    expect(unfilledPlaceholders(noInHouse)).toEqual(['{skills}']);
  });

  it('says what to do: one, two or three placeholders', () => {
    expect(unfilledMessage([])).toBeNull();
    expect(unfilledMessage(['{skills}'])).toBe('Fill or remove {skills} before bidding.');
    expect(unfilledMessage(['{skills}', '{made_up}'])).toBe(
      'Fill or remove {skills} and {made_up} before bidding.',
    );
    expect(unfilledMessage(['{a}', '{b}', '{c}'])).toBe(
      'Fill or remove {a}, {b} and {c} before bidding.',
    );
  });
});

describe('buildProposal', () => {
  const job = { ...project(), price: 450, days: 7 };

  it('fills every placeholder from the project, the price and the days', () => {
    const body =
      'Re {title}: {first_line}\nSkills: {skills}\nBudget {budget}; my price {price} in {timeline_days} days.';
    expect(buildProposal(job, template(body), settings)).toBe(
      'Re Recruiter for Interviews: We need a recruiter to book interviews.\nSkills: PHP, WordPress\nBudget USD 250–750; my price USD 450 in 7 days.',
    );
  });

  it('writes nothing of its own: a template without placeholders comes back as written', () => {
    expect(buildProposal(job, template('Hello. Thanks.'), settings)).toBe('Hello. Thanks.');
  });

  it('leaves unknown placeholders, and ones with nothing to fill them, for the owner to see', () => {
    expect(buildProposal(job, template('{name} {constructor} {Title} {price}'), settings)).toBe(
      '{name} {constructor} {Title} USD 450',
    );
    const bare = {
      ...project({ budgetMin: null, budgetMax: null, skills: [] }),
      price: null,
      days: 5,
    };
    expect(
      buildProposal(bare, template('{skills}|{budget}|{price}|{timeline_days}'), settings),
    ).toBe('{skills}|{budget}|{price}|5');
  });

  it('writes money in the project’s currency, with cents only when there are some', () => {
    const inr = {
      ...project({ currency: 'INR', budgetMin: 1500, budgetMax: 12500 }),
      price: 7500,
      days: 10,
    };
    expect(buildProposal(inr, template('{budget} / {price}'), settings)).toBe(
      `INR 1${NBSP}500–12${NBSP}500 / INR 7${NBSP}500`,
    );
    expect(formatPrice(12.5, 'AUD')).toBe('AUD 12,50');
    expect(formatPrice(1234.05, 'USD')).toBe(`USD 1${NBSP}234,05`);
  });

  it('fills the same placeholder wherever it appears', () => {
    expect(buildProposal(job, template('{price} {price}'), settings)).toBe('USD 450 USD 450');
  });

  it('lists the six placeholders the brief names', () => {
    expect(PLACEHOLDERS.map(([name]) => name)).toEqual([
      '{title}',
      '{skills}',
      '{budget}',
      '{price}',
      '{timeline_days}',
      '{first_line}',
    ]);
  });

  it('describes {first_line} as the page now cuts it: whole words, then …', () => {
    const description = PLACEHOLDERS.find(([name]) => name === '{first_line}')?.[1];
    expect(description).toContain('160');
    expect(description).toContain('…');
  });
});

describe('the bid log', () => {
  const score = {
    total: 64,
    parts: {
      skill: { points: 23.333333, max: 35, why: '' },
      budget: { points: 5.603448, max: 25, why: '' },
      fresh: { points: 19.130435, max: 20, why: '' },
      competition: { points: 19.2, max: 20, why: '' },
    },
  };

  it('keeps what the project, price and score were when the bid was placed', () => {
    const entry = logEntry(
      project({ currency: 'AUD', usdRate: 0.703284 }),
      score,
      { id: 'b1', price: 450, days: 7, proposal: 'Text', template: { id: 't1', name: 'Plain' } },
      NOW,
    );
    expect(entry).toEqual({
      id: 'b1',
      projectId: 40735834,
      title: 'Recruiter for Interviews',
      url: 'https://www.freelancer.com/projects/article-writing/Recruiter-for-Interviews',
      skills: ['PHP', 'WordPress', 'Recruitment'],
      budget: { min: 250, max: 750 },
      type: 'fixed',
      currency: 'AUD',
      usdRate: 0.703284,
      price: 450,
      days: 7,
      templateId: 't1',
      templateName: 'Plain',
      proposal: 'Text',
      score: 64,
      scoreParts: { skill: 23.33, budget: 5.6, fresh: 19.13, competition: 19.2 },
      bidCount: 2,
      ageMinutes: 20,
      placedAt: '2026-09-27T06:53:14.000Z',
      status: 'sent',
      replied: false,
      award: null,
    });
  });

  it('counts this month’s bids by SAST: the month turns at 00:00 SAST on the 1st', () => {
    // 30/09/2026 21:59 UTC is 23:59 SAST, still September; 22:00 UTC is 1 October SAST.
    expect(sastMonth('2026-09-30T21:59:00Z')).toBe('2026-09');
    expect(sastMonth('2026-09-30T22:00:00Z')).toBe('2026-10');
    const at = (placedAt: string) => ({ placedAt }) as LogEntry;
    const log = [
      at('2026-09-30T21:59:00Z'),
      at('2026-09-30T22:00:00Z'),
      at('2026-10-15T10:00:00Z'),
      at('2025-10-15T10:00:00Z'),
    ];
    expect(bidsThisMonth(log, Date.parse('2026-10-20T08:00:00Z'))).toBe(2);
    expect(bidsThisMonth(log, Date.parse('2026-09-30T21:00:00Z'))).toBe(1);
  });
});
