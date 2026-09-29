import { describe, expect, it } from 'vitest';
import type { Project } from './freelancer.js';
import {
  PLACEHOLDERS,
  buildProposal,
  findPlaceholders,
  firstLine,
  openingPrice,
  placeholderProblem,
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

  it('comes back unchanged when it is 160 characters or fewer', () => {
    // 15 words of 9 letters and a space (150 characters), then a 9-letter word and the stop.
    const exact = `${'abcdefghi '.repeat(15)}abcdefghi.`;
    expect(exact).toHaveLength(160);
    expect(firstLine(exact)).toBe(exact);
  });

  it('cuts a 200-character sentence at the last space: no broken word, at most 160 with the …', () => {
    // 19 words of 9 letters and a space (190 characters) and a last word with the stop: 200.
    // Words fill indices 10k to 10k + 8 and the spaces are at 10k + 9, so the last space
    // within the first 160 characters is at 159. The text kept is 0 to 158: 15 words and
    // the 16th, whole, which is 159 characters; the … makes 160.
    const long = `${'abcdefghi '.repeat(19)}abcdefghi.`;
    expect(long).toHaveLength(200);
    const cut = firstLine(long);
    expect(cut).toBe(`${'abcdefghi '.repeat(15)}abcdefghi…`);
    expect(cut).toHaveLength(160);
  });

  it('drops a word the cut would break: the 160th character is inside 0123456789ABCDEF', () => {
    // 15 words (150 characters), then a 16-character word at 150 to 165. The last space
    // within the first 160 is at 149, so 14 words and "abcdefghi" are kept: 149 characters.
    const long = `${'abcdefghi '.repeat(15)}0123456789ABCDEF and then a good deal more words.`;
    const cut = firstLine(long);
    expect(cut).toBe(`${'abcdefghi '.repeat(14)}abcdefghi…`);
    expect(cut).toHaveLength(150);
    expect(cut).not.toContain('0123456789ABCDEF');
  });

  it('cuts a sentence of 161 characters, the shortest that must be cut, and stays within 160', () => {
    const long = `${'abcdefghi '.repeat(15)}abcdefghij.`;
    expect(long).toHaveLength(161);
    // The last space within the first 160 is at 149: "abcdefghij." goes.
    expect(firstLine(long)).toBe(`${'abcdefghi '.repeat(14)}abcdefghi…`);
  });

  it('with no space in the first 159 characters, cuts at 159 and adds the …', () => {
    const cut = firstLine(`${'a'.repeat(200)}.`);
    expect(cut).toBe(`${'a'.repeat(159)}…`);
    expect(cut).toHaveLength(160);
  });

  it('never ends on half of an emoji', () => {
    // 158 letters, then 😀 in two UTF-16 units at 158 and 159: cutting at 159 would keep
    // its first half, which is dropped.
    const cut = firstLine(`${'a'.repeat(158)}😀${'b'.repeat(40)}.`);
    expect(cut).toBe(`${'a'.repeat(158)}…`);
  });
});

describe('placeholders in a proposal (B-01)', () => {
  it('finds {skills}, {Client_Name}, { name } and {made-up} in one text, as written', () => {
    expect(
      findPlaceholders('Hi { name }, I can do {skills} for {Client_Name}. It is {made-up}.'),
    ).toEqual(['{ name }', '{skills}', '{Client_Name}', '{made-up}']);
  });

  it('lists each distinct one once, in the order it first appears', () => {
    expect(findPlaceholders('{a} {b} {a} {c} {b}')).toEqual(['{a}', '{b}', '{c}']);
  });

  it('finds nothing in a clean text', () => {
    expect(findPlaceholders('Hello. I can do this for USD 450 in 7 days.')).toEqual([]);
    expect(findPlaceholders('')).toEqual([]);
  });

  it('counts any text in braces: words, a dot, code, a number', () => {
    expect(findPlaceholders('{first line} {project.title} { color: red; } {1} {"a": 1}')).toEqual([
      '{first line}',
      '{project.title}',
      '{ color: red; }',
      '{1}',
      '{"a": 1}',
    ]);
  });

  it('leaves alone what holds no text between braces, or does not close: {} and a lone brace', () => {
    expect(findPlaceholders('{} } { and then {')).toEqual([]);
  });

  it('takes up to 40 characters between the braces, and no more', () => {
    const forty = 'a'.repeat(40);
    expect(findPlaceholders(`{${forty}}`)).toEqual([`{${forty}}`]);
    expect(findPlaceholders(`{${forty}a}`)).toEqual([]);
  });

  it('does not reach across a line: the braces must close on the line they open', () => {
    expect(findPlaceholders('{first\nline}')).toEqual([]);
  });

  it('finds the inner braces of {{doubled}} ones', () => {
    expect(findPlaceholders('Hello {{skills}}')).toEqual(['{skills}']);
  });

  it('finds what buildProposal could not fill: {skills} with no in-house overlap', () => {
    const job = { ...project(), price: 450, days: 7 };
    const noOverlap = buildProposal(job, template('Skills: {skills}. {price}'), {
      inHouse: [{ id: 555 }], // a skill none of the project's three skills matches
    });
    expect(noOverlap).toBe('Skills: {skills}. USD 450');
    expect(findPlaceholders(noOverlap)).toEqual(['{skills}']);
    // With one that matches, the text is whole.
    const filled = buildProposal(job, template('Skills: {skills}. {price}'), settings);
    expect(findPlaceholders(filled)).toEqual([]);
  });

  it('says what to do, and lists every one found', () => {
    expect(placeholderProblem([])).toBeNull();
    expect(placeholderProblem(['{skills}'])).toBe(
      'Fill or remove {skills} before bidding. Any text in curly braces is blocked.',
    );
    expect(placeholderProblem(['{skills}', '{Client_Name}'])).toBe(
      'Fill or remove {skills}, {Client_Name} before bidding. Any text in curly braces is blocked.',
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
