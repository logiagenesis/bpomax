import { describe, expect, it } from 'vitest';
import type { Project } from './freelancer.js';
import { band, byRank, scoreProject } from './score.js';
import { DEFAULT_SETTINGS } from './store.js';

/**
 * The rank score (LI-PROMPT-BPOMAX-RADAR-20260927, 4.2), worked by hand. Default weights:
 * skill fit 35, budget 25, freshness 20, competition 20.
 */
const MIN = 60_000;
const NOW = 1_790_500_000_000;
const IN_HOUSE = [
  { id: 3, name: 'PHP' },
  { id: 17, name: 'WordPress' },
  { id: 20, name: 'HTML' },
];
const settings = { inHouse: IN_HOUSE, weights: DEFAULT_SETTINGS.weights };

const skills = (...ids: number[]) => ids.map((id) => ({ id, name: `S${String(id)}` }));

function project(over: Partial<Project>): Project {
  return {
    id: 1,
    title: 't',
    description: '',
    url: 'https://www.freelancer.com/projects/x',
    type: 'fixed',
    currency: 'USD',
    usdRate: 1,
    budgetMin: null,
    budgetMax: null,
    bidCount: 0,
    bidAvg: null,
    submitted: NOW,
    skills: [],
    upgrades: { nda: false, sealed: false, urgent: false, featured: false },
    ...over,
  };
}

const points = (p: Project, s = settings) => {
  const { parts } = scoreProject(p, s, NOW);
  return {
    skill: parts.skill.points,
    budget: parts.budget.points,
    fresh: parts.fresh.points,
    competition: parts.competition.points,
  };
};

describe('scoreProject, hand-worked', () => {
  it('1. every part full: all skills in-house, USD 3 000, just posted, no bids → 100', () => {
    const p = project({ skills: skills(3, 17), budgetMin: 1500, budgetMax: 3000 });
    expect(points(p)).toEqual({ skill: 35, budget: 25, fresh: 20, competition: 20 });
    expect(scoreProject(p, settings, NOW).total).toBe(100);
  });

  it('2. every part half: 1 of 4 skills… → 8,75 + 12,5 + 10 + 10 = 41,25 → 41', () => {
    // 1 of 4 skills = 0,25 × 35 = 8,75. USD 1 550: (1 550 − 100) / 2 900 = 0,5 × 25 = 12,5.
    // 187,5 min: (360 − 187,5) / 345 = 0,5 × 20 = 10. 25 bids: 25 / 50 = 0,5 × 20 = 10.
    const p = project({
      skills: skills(3, 99, 100, 101),
      budgetMax: 1550,
      submitted: NOW - 187.5 * MIN,
      bidCount: 25,
    });
    expect(points(p)).toEqual({ skill: 8.75, budget: 12.5, fresh: 10, competition: 10 });
    expect(scoreProject(p, settings, NOW).total).toBe(41);
  });

  it('3. hourly AUD 30 at 0,703284, exactly 15 min old, 50 bids → 27', () => {
    // No skill in-house = 0. AUD 30 × 0,703284 = USD 21,09852/h: (21,09852 − 10) / 40 =
    // 0,277463 × 25 = 6,936575. 15 min is the full-points edge = 20. 50 bids is the zero edge.
    const p = project({
      type: 'hourly',
      currency: 'AUD',
      usdRate: 0.703284,
      budgetMin: 15,
      budgetMax: 30,
      skills: skills(5),
      submitted: NOW - 15 * MIN,
      bidCount: 50,
    });
    const got = points(p);
    expect(got.skill).toBe(0);
    expect(got.budget).toBeCloseTo(6.936575, 6);
    expect(got.fresh).toBe(20);
    expect(got.competition).toBe(0);
    expect(scoreProject(p, settings, NOW).total).toBe(27);
  });

  it('4. every part at its zero edge: no skills, USD 100, 6 hours old, 60 bids → 0', () => {
    const p = project({ budgetMax: 100, submitted: NOW - 360 * MIN, bidCount: 60 });
    expect(points(p)).toEqual({ skill: 0, budget: 0, fresh: 0, competition: 0 });
    expect(scoreProject(p, settings, NOW).total).toBe(0);
  });

  it('5. INR 1 500–12 500 at 0,010436, 2 of 3 skills, 1 hour old, 5 bids → 59', () => {
    // INR 12 500 × 0,010436 = USD 130,45: 30,45 / 2 900 = 0,0105 × 25 = 0,2625.
    // 2 / 3 × 35 = 23,3333. 60 min: 300 / 345 × 20 = 17,3913. 5 bids: 45 / 50 × 20 = 18.
    // 0,2625 + 23,3333 + 17,3913 + 18 = 58,9871 → 59.
    const p = project({
      currency: 'INR',
      usdRate: 0.010436,
      budgetMin: 1500,
      budgetMax: 12500,
      skills: skills(3, 20, 400),
      submitted: NOW - 60 * MIN,
      bidCount: 5,
    });
    const got = points(p);
    expect(got.budget).toBeCloseTo(0.2625, 6);
    expect(got.skill).toBeCloseTo(23.333333, 5);
    expect(got.fresh).toBeCloseTo(17.391304, 5);
    expect(got.competition).toBe(18);
    expect(scoreProject(p, settings, NOW).total).toBe(59);
  });

  it('6. hourly with only a minimum of USD 50, 16 min old, 49 bids → 80', () => {
    // USD 50/h is the full edge = 25. 1 of 1 skill = 35. 16 min: 344 / 345 × 20 = 19,942.
    // 49 bids: 1 / 50 × 20 = 0,4. 25 + 35 + 19,942 + 0,4 = 80,342 → 80.
    const p = project({
      type: 'hourly',
      budgetMin: 50,
      skills: skills(17),
      submitted: NOW - 16 * MIN,
      bidCount: 49,
    });
    const got = points(p);
    expect(got.budget).toBe(25);
    expect(got.skill).toBe(35);
    expect(got.fresh).toBeCloseTo(19.942029, 5);
    expect(got.competition).toBeCloseTo(0.4, 10);
    expect(scoreProject(p, settings, NOW).total).toBe(80);
  });

  it('7. beyond the edges stays in range: USD 5 000, posted "in the future", USD 9/h', () => {
    expect(points(project({ budgetMax: 5000, submitted: NOW + 5 * MIN }))).toMatchObject({
      budget: 25,
      fresh: 20,
    });
    expect(points(project({ type: 'hourly', budgetMax: 9 })).budget).toBe(0);
    expect(points(project({ type: 'hourly', budgetMax: 10 })).budget).toBe(0);
  });

  it('8. no budget scores nothing for budget, and says so', () => {
    const { parts } = scoreProject(project({}), settings, NOW);
    expect(parts.budget).toEqual({ points: 0, max: 25, why: 'no budget given' });
  });

  it('explains each part', () => {
    const p = project({
      skills: skills(3, 99),
      budgetMax: 750,
      submitted: NOW - 14 * MIN,
      bidCount: 3,
    });
    const { parts } = scoreProject(p, settings, NOW);
    expect(parts.skill.why).toBe('1 of 2 skills delivered in-house');
    expect(parts.budget.why).toBe('up to USD 750 (full at USD 3000)');
    expect(parts.fresh.why).toBe('posted 14 min ago');
    expect(parts.competition.why).toBe('3 bids so far (none at 50)');
    expect(
      scoreProject(project({ type: 'hourly', budgetMax: 25 }), settings, NOW).parts.budget.why,
    ).toBe('up to USD 25 an hour (full at USD 50)');
  });
});

describe('the owner’s weights', () => {
  it('are scaled to 100 when they add up to something else', () => {
    const even = {
      inHouse: IN_HOUSE,
      weights: { skill: 10, budget: 10, fresh: 10, competition: 10 },
    };
    const full = project({ skills: skills(3), budgetMax: 3000 });
    expect(scoreProject(full, even, NOW).total).toBe(100);
    // Case 2 again, each part now worth 25: 6,25 + 12,5 + 12,5 + 12,5 = 43,75 → 44.
    const half = project({
      skills: skills(3, 99, 100, 101),
      budgetMax: 1550,
      submitted: NOW - 187.5 * MIN,
      bidCount: 25,
    });
    expect(scoreProject(half, even, NOW).total).toBe(44);
    expect(scoreProject(half, even, NOW).parts.skill.max).toBe(25);
  });

  it('a part with no weight counts for nothing', () => {
    const skillOnly = {
      inHouse: IN_HOUSE,
      weights: { skill: 35, budget: 0, fresh: 0, competition: 0 },
    };
    expect(scoreProject(project({ skills: skills(3, 99) }), skillOnly, NOW).total).toBe(50);
  });

  it('all weights at zero score 0 rather than divide by zero', () => {
    const none = { inHouse: IN_HOUSE, weights: { skill: 0, budget: 0, fresh: 0, competition: 0 } };
    expect(scoreProject(project({ skills: skills(3), budgetMax: 3000 }), none, NOW).total).toBe(0);
  });
});

describe('ranking', () => {
  it('sorts highest score first, and the newest first on a tie', () => {
    const entry = (id: number, total: number, submitted: number) => ({
      project: project({ id, submitted }),
      score: { total, parts: {} as never },
    });
    const sorted = byRank([entry(1, 50, 1), entry(2, 80, 1), entry(3, 50, 5), entry(4, 10, 9)]);
    expect(sorted.map((e) => e.project.id)).toEqual([2, 3, 1, 4]);
  });

  it('puts scores in the tracker’s three bands', () => {
    expect([0, 39, 40, 69, 70, 100].map(band)).toEqual([
      '0–39',
      '0–39',
      '40–69',
      '40–69',
      '70–100',
      '70–100',
    ]);
  });
});
