import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOBID,
  autoBidsToday,
  decide,
  sastDay,
  switchOnProblems,
  type AutoBid,
} from './autobid.js';
import type { Project } from './freelancer.js';
import type { Template } from './proposal.js';
import type { Score } from './score.js';
import { DEFAULT_SETTINGS, type Settings } from './store.js';
import type { LogEntry } from './tracker.js';

/**
 * Auto-bid's decision (LI-PROMPT-BPOMAX-AUTOBID-20260928, constraint 4 and step 6), on
 * hand-worked projects. Each case says what the rules make of it and why, worked out
 * below by hand, not by running the code:
 *
 * The owner's rules: WordPress (17) delivered in-house; price 60 % of the project's
 * maximum; 7 days; 100 bids a month; Auto-bid's defaults (10 a day, score 70 or more,
 * 15 minutes old at most); one default template. It is 28/09/2026 10:00 SAST.
 */
const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 28, 8, 0); // 10:00 SAST
const WORDPRESS = { id: 17, name: 'WordPress' };
const PHP = { id: 3, name: 'PHP' };
const LOGO = { id: 32, name: 'Logo Design' };

const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  inHouse: [WORDPRESS],
  pricePct: 60,
  defaultDays: 7,
  monthlyLimit: 100,
};
const auto: AutoBid = { ...DEFAULT_AUTOBID, on: true };
const TEMPLATE: Template = {
  id: 't1',
  name: 'WordPress',
  body: 'Hello. I will build {title} for {price} in {timeline_days} days.',
  isDefault: true,
};
const templates = [{ ...TEMPLATE, id: 't0', name: 'Other', isDefault: false }, TEMPLATE];

function project(id: number, over: Partial<Project> = {}): Project {
  return {
    id,
    title: `Project ${String(id)}`,
    description: 'A site.',
    url: `https://www.freelancer.com/projects/p-${String(id)}`,
    type: 'fixed',
    currency: 'USD',
    usdRate: 1,
    budgetMin: 250,
    budgetMax: 750,
    bidCount: 3,
    bidAvg: null,
    submitted: NOW - 5 * MIN,
    skills: [WORDPRESS, PHP],
    upgrades: { nda: false, sealed: false, urgent: false, featured: false },
    ...over,
  };
}

const score = (total: number) => ({ total }) as Score;

function logged(projectId: number, placedAt: number, placedBy?: 'auto' | 'manual'): LogEntry {
  return {
    id: `b${String(projectId)}`,
    projectId,
    placedAt: new Date(placedAt).toISOString(),
    ...(placedBy ? { placedBy } : {}),
  } as LogEntry;
}

const base = {
  auto,
  settings,
  templates,
  log: [] as LogEntry[],
  dismissed: new Set<number>(),
  now: NOW,
};

describe('Auto-bid decides each project by hand-worked rules', () => {
  it('1. a fresh WordPress project scoring 82 is bid on: 60 % of 750 is 450, 7 days, the default template', () => {
    expect(decide(project(1), score(82), base)).toEqual({
      place: true,
      price: 450,
      days: 7,
      template: TEMPLATE,
      proposal: 'Hello. I will build Project 1 for USD 450 in 7 days.',
    });
  });

  it('2. a project already in the log is skipped', () => {
    const log = [logged(2, NOW - 60 * MIN, 'manual')];
    expect(decide(project(2), score(90), { ...base, log })).toEqual({
      place: false,
      reason: 'Already bid on.',
    });
  });

  it('3. a project the owner dismissed is skipped', () => {
    expect(decide(project(3), score(90), { ...base, dismissed: new Set([3]) })).toEqual({
      place: false,
      reason: 'You dismissed it.',
    });
  });

  it('4. posted 16 minutes ago is over the 15-minute limit; at exactly 15 it is bid on', () => {
    expect(decide(project(4, { submitted: NOW - 16 * MIN }), score(90), base)).toEqual({
      place: false,
      reason: 'Posted 16 minutes ago; the limit is 15.',
    });
    expect(decide(project(4, { submitted: NOW - 15 * MIN }), score(90), base)).toMatchObject({
      place: true,
    });
  });

  it('5. scoring 69 is under the floor of 70; 70 itself is bid on', () => {
    expect(decide(project(5), score(69), base)).toEqual({
      place: false,
      reason: 'Scores 69; the lowest bid on is 70.',
    });
    expect(decide(project(5), score(70), base)).toMatchObject({ place: true });
  });

  it('6. a logo project, with no in-house skill, is skipped', () => {
    expect(decide(project(6, { skills: [LOGO] }), score(95), base)).toEqual({
      place: false,
      reason: 'None of its skills is delivered in-house.',
    });
  });

  it('7. a project with no budget cannot be priced, so it is skipped', () => {
    expect(decide(project(7, { budgetMin: null, budgetMax: null }), score(90), base)).toEqual({
      place: false,
      reason: 'It gives no budget to price from.',
    });
  });

  it('8. after 10 automatic bids today, the 11th waits for tomorrow', () => {
    const log = Array.from({ length: 10 }, (_, i) => logged(100 + i, NOW - (i + 1) * MIN, 'auto'));
    expect(decide(project(8), score(90), { ...base, log })).toEqual({
      place: false,
      reason: 'The daily cap is reached: 10 automatic bids today.',
    });
  });

  it('9. bids the owner placed by hand today do not count towards the daily cap', () => {
    const log = Array.from({ length: 10 }, (_, i) =>
      logged(100 + i, NOW - (i + 1) * MIN, 'manual'),
    );
    expect(decide(project(9), score(90), { ...base, log })).toMatchObject({ place: true });
  });

  it('10. ten automatic bids placed yesterday (SAST) leave today’s cap untouched', () => {
    // 23:30 SAST on 27/09 is 21:30 UTC, the day before 28/09 in SAST.
    const yesterday = Date.UTC(2026, 8, 27, 21, 30);
    const log = Array.from({ length: 10 }, (_, i) => logged(100 + i, yesterday, 'auto'));
    expect(autoBidsToday(log, NOW)).toBe(0);
    expect(decide(project(10), score(90), { ...base, log })).toMatchObject({ place: true });
  });

  it('11. with 100 bids this month, manual and automatic, the allowance is used', () => {
    const log = Array.from({ length: 100 }, (_, i) =>
      logged(1000 + i, Date.UTC(2026, 8, 1, 8) + i * MIN, i % 2 ? 'auto' : undefined),
    );
    expect(decide(project(11), score(90), { ...base, log })).toEqual({
      place: false,
      reason: 'This month’s 100 bids are used.',
    });
  });

  it('12. 99 bids this month leave room for one more', () => {
    const log = Array.from({ length: 99 }, (_, i) =>
      logged(1000 + i, Date.UTC(2026, 8, 1, 8) + i * MIN),
    );
    expect(decide(project(12), score(90), { ...base, log })).toMatchObject({ place: true });
  });

  it('13. a small budget is priced at its minimum: 60 % of 40 is 24, under the minimum of 30', () => {
    expect(decide(project(13, { budgetMin: 30, budgetMax: 40 }), score(90), base)).toMatchObject({
      place: true,
      price: 30,
    });
  });

  it('14. with no default template, nothing is bid on', () => {
    expect(
      decide(project(14), score(90), { ...base, templates: [{ ...TEMPLATE, isDefault: false }] }),
    ).toEqual({ place: false, reason: 'No default template.' });
  });

  it('15. a project in another currency is priced in that currency: 60 % of INR 12 500 is 7 500', () => {
    expect(
      decide(
        project(15, { currency: 'INR', usdRate: 0.012, budgetMin: 1500, budgetMax: 12500 }),
        score(75),
        base,
      ),
    ).toMatchObject({ place: true, price: 7500 });
  });
});

describe('the SAST day', () => {
  it('turns at 00:00 SAST, 22:00 UTC', () => {
    expect(sastDay(Date.UTC(2026, 8, 27, 21, 59))).toBe('2026-09-27');
    expect(sastDay(Date.UTC(2026, 8, 27, 22, 0))).toBe('2026-09-28');
  });
});

describe('what must be set before Auto-bid can be switched on', () => {
  const ready = { auto, settings, templates, tokenOk: true };

  it('nothing, when every guardrail is set', () => {
    expect(switchOnProblems(ready)).toEqual([]);
  });

  it('every missing guardrail, in words', () => {
    expect(
      switchOnProblems({
        auto: { on: false, dailyCap: 0, minScore: Number.NaN, maxAgeMinutes: 0 },
        settings: { ...settings, monthlyLimit: null, inHouse: [] },
        templates: [],
        tokenOk: false,
      }),
    ).toEqual([
      'Paste a Freelancer token that Freelancer.com accepts.',
      'Set the most automatic bids a day, 1 or more.',
      'Set the oldest project to bid on, in minutes.',
      'Set the bids your membership allows a month, under Bidding.',
      'Pick at least one skill delivered in-house.',
      'Mark one template as the default.',
    ]);
  });

  it('a score floor left empty is caught by the scanners’ own rule', () => {
    expect(
      switchOnProblems({ ...ready, auto: { ...auto, minScore: null as unknown as number } }),
    ).toEqual(['Set the lowest rank score to bid on.']);
  });
});
