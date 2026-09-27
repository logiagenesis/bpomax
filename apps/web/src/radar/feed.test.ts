import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFilters, excludedWords } from './filter.js';
import {
  FreelancerError,
  MAX_PROJECTS,
  fetchProjects,
  fetchSkills,
  nextDelayMs,
  normaliseProject,
  projectsUrl,
  topUsd,
  type Project,
} from './freelancer.js';
import { DEFAULT_SETTINGS, mergeSettings, readJson, writeJson } from './store.js';
import { budgetText, formatAge, formatAmount, formatRange } from './text.js';

/**
 * The radar's feed (LI-PROMPT-BPOMAX-RADAR-20260927, 4.1), against a real response from
 * Freelancer.com's public search saved on 27/09/2026 (e2e/fixtures/radar, trimmed).
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../e2e/fixtures/radar/${name}`, import.meta.url), 'utf8'),
  );
const PROJECTS = fixture('projects.json');
const NBSP = ' ';

const MIN = 60_000;
const NOW = 1_790_500_000_000;

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    title: 'Build a WordPress site',
    description: 'We need a site.',
    url: 'https://www.freelancer.com/projects/wordpress/Build-site',
    type: 'fixed',
    currency: 'USD',
    usdRate: 1,
    budgetMin: 250,
    budgetMax: 750,
    bidCount: 3,
    bidAvg: 400,
    submitted: NOW - 10 * MIN,
    skills: [{ id: 17, name: 'WordPress' }],
    upgrades: { nda: false, sealed: false, urgent: false, featured: false },
    ...over,
  };
}

describe('the search URL', () => {
  it('asks for 100 projects newest first, with descriptions and skills, one jobs[] per skill', () => {
    const url = new URL(projectsUrl([3, 17], 200));
    expect(url.origin + url.pathname).toBe(
      'https://www.freelancer.com/api/projects/0.1/projects/active/',
    );
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'jobs[]'))).toEqual({
      limit: '100',
      offset: '200',
      full_description: 'true',
      job_details: 'true',
      sort_field: 'time_submitted',
    });
    expect(url.searchParams.getAll('jobs[]')).toEqual(['3', '17']);
  });

  it('reads every project when no skill is picked', () => {
    expect(new URL(projectsUrl([], 0)).searchParams.has('jobs[]')).toBe(false);
  });
});

describe('a project from the search', () => {
  it('keeps what the page shows, from the real response', () => {
    const raw = PROJECTS.result.projects[0];
    const p = normaliseProject(raw);
    expect(p).toEqual({
      id: raw.id,
      title: raw.title,
      description: raw.description,
      url: `https://www.freelancer.com/projects/${raw.seo_url}`,
      type: raw.type,
      currency: raw.currency.code,
      usdRate: raw.currency.exchange_rate,
      budgetMin: raw.budget.minimum,
      budgetMax: raw.budget.maximum,
      bidCount: raw.bid_stats.bid_count,
      bidAvg: raw.bid_stats.bid_avg,
      submitted: raw.time_submitted * 1000,
      skills: raw.jobs.map((j: { id: number; name: string }) => ({ id: j.id, name: j.name })),
      upgrades: {
        nda: raw.upgrades.NDA,
        sealed: raw.upgrades.sealed,
        urgent: raw.upgrades.urgent,
        featured: raw.upgrades.featured,
      },
    });
  });

  it('reads every project in the saved response, fixed and hourly', () => {
    const all = PROJECTS.result.projects.map(normaliseProject);
    expect(all).toHaveLength(40);
    expect(new Set(all.map((p: Project) => p.type))).toEqual(new Set(['fixed', 'hourly']));
    for (const p of all) expect(p.usdRate).toBeGreaterThan(0);
  });

  it('survives missing fields', () => {
    expect(normaliseProject({ id: 5, title: 'x' })).toMatchObject({
      id: 5,
      type: 'fixed',
      currency: 'USD',
      usdRate: 1,
      budgetMin: null,
      budgetMax: null,
      bidCount: 0,
      bidAvg: null,
      skills: [],
      url: 'https://www.freelancer.com/projects/5',
    });
  });

  it('is worth its maximum times the rate in USD (F4), or its minimum with no maximum', () => {
    expect(topUsd(project({ currency: 'AUD', usdRate: 0.703284, budgetMax: 1000 }))).toBeCloseTo(
      703.284,
    );
    expect(topUsd(project({ budgetMax: null, budgetMin: 50 }))).toBe(50);
    expect(topUsd(project({ budgetMax: null, budgetMin: null }))).toBeNull();
  });
});

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('reading the feed', () => {
  it('reads three pages of 100 at most, and each project once', async () => {
    const page = (offset: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: offset === 100 && i === 0 ? 99 : offset + i, // one project slid into page 2
        title: `P${String(offset + i)}`,
      }));
    const calls: string[] = [];
    const fake = vi.fn(async (url: string) => {
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return answer({ status: 'success', result: { projects: page(offset) } });
    });
    const list = await fetchProjects([3], fake as unknown as typeof fetch);
    expect(calls).toHaveLength(3);
    expect(list).toHaveLength(MAX_PROJECTS - 1);
  });

  it('stops at a short page', async () => {
    const fake = vi.fn(async () => answer(PROJECTS));
    const list = await fetchProjects([], fake as unknown as typeof fetch);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(list).toHaveLength(40);
  });

  it('says what Freelancer.com answered on an error, with its status', async () => {
    const fake = async () => answer({ status: 'error', message: 'Too many requests' }, 429);
    const error = await fetchProjects([], fake as unknown as typeof fetch).catch((e) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    expect(error.status).toBe(429);
    expect(error.message).toBe('Freelancer.com answered HTTP 429: Too many requests.');
  });

  it('says when nothing came back at all', async () => {
    const fake = async () => {
      throw new TypeError('Failed to fetch');
    };
    const error = await fetchProjects([], fake as unknown as typeof fetch).catch((e) => e);
    expect(error.status).toBeNull();
    expect(error.message).toBe('Could not reach Freelancer.com (Failed to fetch).');
  });

  it('refuses a 200 that is not a success, or not JSON', async () => {
    const notJson = async () => new Response('<html>', { status: 200 });
    await expect(fetchProjects([], notJson as unknown as typeof fetch)).rejects.toThrow(
      'Freelancer.com answered HTTP 200.',
    );
  });

  it('reads the skills list sorted by name', async () => {
    const fake = async () => answer(fixture('jobs.json'));
    const list = await fetchSkills(fake as unknown as typeof fetch);
    expect(list.length).toBeGreaterThan(100);
    expect(list[0]).toEqual({ id: expect.any(Number), name: expect.any(String) });
    const names = list.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-GB')));
    expect(list.find((s) => s.name === 'PHP')).toEqual({ id: 3, name: 'PHP' });
  });
});

describe('when to read again', () => {
  it('waits the owner’s interval while reads succeed', () => {
    expect(nextDelayMs(0, 2)).toBe(2 * MIN);
    expect(nextDelayMs(0, 10)).toBe(10 * MIN);
  });

  it('backs off 4, 8, 16, then 30 minutes at most after failures', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => nextDelayMs(n, 2)! / MIN)).toEqual([4, 8, 16, 30, 30, 30]);
  });

  it('never reads on its own when refresh is manual', () => {
    expect(nextDelayMs(0, 0)).toBeNull();
    expect(nextDelayMs(3, 0)).toBeNull();
  });
});

describe('filters', () => {
  const base = DEFAULT_SETTINGS.filters;
  const context = { acted: new Set<number>(), now: NOW };
  const run = (list: Project[], over: Partial<typeof base>, acted = context.acted) =>
    applyFilters(list, { ...base, ...over }, { acted, now: NOW }).map((p) => p.id);

  it('keeps everything by default', () => {
    expect(run([project({ id: 1 }), project({ id: 2, type: 'hourly' })], {})).toEqual([1, 2]);
  });

  it('by type', () => {
    const list = [project({ id: 1 }), project({ id: 2, type: 'hourly' })];
    expect(run(list, { type: 'fixed' })).toEqual([1]);
    expect(run(list, { type: 'hourly' })).toEqual([2]);
  });

  it('by budget in USD, fixed and hourly each by their own minimum', () => {
    const list = [
      project({ id: 1, budgetMax: 750 }),
      project({ id: 2, currency: 'INR', usdRate: 0.010436, budgetMax: 12500 }), // USD 130,45
      project({ id: 3, type: 'hourly', budgetMax: 25 }),
      project({ id: 4, type: 'hourly', budgetMax: 8 }),
    ];
    expect(run(list, { minBudgetUsd: 500 })).toEqual([1, 3, 4]);
    expect(run(list, { minBudgetUsd: 130 })).toEqual([1, 2, 3, 4]);
    expect(run(list, { minHourlyUsd: 10 })).toEqual([1, 2, 3]);
  });

  it('by bids, age and words in the title', () => {
    const list = [
      project({ id: 1, bidCount: 5, title: 'Logo contest' }),
      project({ id: 2, bidCount: 30, submitted: NOW - 5 * 60 * MIN }),
      project({ id: 3, title: 'Just a TEST project' }),
    ];
    expect(run(list, { maxBids: 10 })).toEqual([1, 3]);
    expect(run(list, { maxAgeHours: 2 })).toEqual([1, 3]);
    expect(run(list, { excludeWords: ' Contest, test ,, ' })).toEqual([2]);
  });

  it('hides projects bid on or dismissed, unless told not to', () => {
    const list = [project({ id: 1 }), project({ id: 2 })];
    expect(run(list, {}, new Set([2]))).toEqual([1]);
    expect(run(list, { hideActed: false }, new Set([2]))).toEqual([1, 2]);
  });

  it('splits the exclude box into words', () => {
    expect(excludedWords('')).toEqual([]);
    expect(excludedWords('A, b ,c')).toEqual(['a', 'b', 'c']);
  });
});

describe('how amounts and ages read', () => {
  it('amounts are whole units with the code first', () => {
    expect(formatAmount(12500, 'INR')).toBe(`INR 12${NBSP}500`);
    expect(formatAmount(130.45, 'USD')).toBe('USD 130');
    expect(formatRange(250, 750, 'USD')).toBe('USD 250–750');
    expect(formatRange(250, 250, 'USD')).toBe('USD 250');
    expect(formatRange(null, 30, 'AUD')).toBe('AUD 30');
    expect(formatRange(null, null, 'AUD')).toBeNull();
  });

  it('a budget shows USD too when in another currency', () => {
    expect(budgetText(project())).toBe('USD 250–750 · Fixed');
    expect(
      budgetText(
        project({ currency: 'INR', usdRate: 0.010436, budgetMin: 1500, budgetMax: 12500 }),
      ),
    ).toBe(`INR 1${NBSP}500–12${NBSP}500 (USD 16–130) · Fixed`);
    expect(
      budgetText(
        project({ type: 'hourly', currency: 'AUD', usdRate: 0.7, budgetMin: 15, budgetMax: 25 }),
      ),
    ).toBe('AUD 15–25 (USD 11–18) per hour · Hourly');
    expect(budgetText(project({ budgetMin: null, budgetMax: null }))).toBe(
      'No budget given · Fixed',
    );
  });

  it('ages', () => {
    expect(formatAge(NOW - 30_000, NOW)).toBe('just now');
    expect(formatAge(NOW - 14 * MIN, NOW)).toBe('14 min ago');
    expect(formatAge(NOW - 60 * MIN, NOW)).toBe('1 h ago');
    expect(formatAge(NOW - 47 * 60 * MIN, NOW)).toBe('47 h ago');
    expect(formatAge(NOW - 50 * 60 * MIN, NOW)).toBe('2 d ago');
  });
});

describe('what the browser keeps', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back quietly when storage is missing or refuses', () => {
    expect(readJson('settings', 'fallback')).toBe('fallback');
    expect(writeJson('settings', { a: 1 })).toBe(false);
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(readJson('settings', 'fallback')).toBe('fallback');
    expect(writeJson('settings', { a: 1 })).toBe(false);
  });

  it('keeps under radar.*', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    expect(writeJson('dismissed', [1, 2])).toBe(true);
    expect([...data.keys()]).toEqual(['radar.dismissed']);
    expect(readJson('dismissed', [])).toEqual([1, 2]);
  });

  it('settings saved before a setting existed get its default', () => {
    const merged = mergeSettings({ pricePct: 55, filters: { maxBids: 20 } });
    expect(merged.pricePct).toBe(55);
    expect(merged.filters).toEqual({ ...DEFAULT_SETTINGS.filters, maxBids: 20 });
    expect(merged.weights).toEqual(DEFAULT_SETTINGS.weights);
    expect(mergeSettings('rubbish')).toEqual(DEFAULT_SETTINGS);
  });
});
