import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  directoryUrl,
  fetchDevelopers,
  normaliseDeveloper,
  pickDevelopers,
  toShortlist,
  type Developer,
} from './developers.js';

/**
 * The developer finder (LI-PROMPT-BPOMAX-RADAR-20260927, 4.6), against a real answer from
 * Freelancer.com's directory saved on 27/09/2026 (query "wordpress", trimmed).
 */
const DIRECTORY = JSON.parse(
  readFileSync(new URL('../../../../e2e/fixtures/radar/directory.json', import.meta.url), 'utf8'),
);

describe('the directory search', () => {
  it('asks for 50 with reputation and country', () => {
    const url = new URL(directoryUrl('wordpress & php'));
    expect(url.origin + url.pathname).toBe(
      'https://www.freelancer.com/api/users/0.1/users/directory/',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'wordpress & php',
      limit: '50',
      reputation: 'true',
      country_details: 'true',
    });
  });

  it('reads the fields the directory really gives', () => {
    const raw = DIRECTORY.result.users[0];
    expect(normaliseDeveloper(raw)).toEqual({
      id: raw.id,
      username: raw.username,
      profile: `https://www.freelancer.com/u/${raw.username}`,
      country: raw.location.country.name,
      hourlyRateUsd: raw.hourly_rate,
      jobs: raw.reputation.entire_history.all,
      completed: raw.reputation.entire_history.complete,
      reviews: raw.reputation.entire_history.reviews,
      rating: raw.reputation.entire_history.overall,
      completionRate: raw.reputation.entire_history.completion_rate,
    });
  });

  it('survives a user with no reputation or location', () => {
    expect(normaliseDeveloper({ id: 1, username: 'new user' })).toEqual({
      id: 1,
      username: 'new user',
      profile: 'https://www.freelancer.com/u/new%20user',
      country: null,
      hourlyRateUsd: null,
      jobs: 0,
      completed: 0,
      reviews: 0,
      rating: null,
      completionRate: null,
    });
  });

  it('fetches and reads every user in the answer', async () => {
    const fake = async () => new Response(JSON.stringify(DIRECTORY));
    const list = await fetchDevelopers('wordpress', fake as unknown as typeof fetch);
    expect(list).toHaveLength(DIRECTORY.result.users.length);
  });
});

describe('the owner’s filters and order', () => {
  const dev = (
    username: string,
    rating: number,
    reviews: number,
    completion: number,
  ): Developer => ({
    id: 1,
    username,
    profile: '',
    country: null,
    hourlyRateUsd: 20,
    jobs: reviews,
    completed: reviews,
    reviews,
    rating,
    completionRate: completion,
  });

  it('keeps completion ≥ 90 % and reviews ≥ 20 by default, best rated then most reviewed first', () => {
    const list = [
      dev('a', 4.9, 100, 0.95),
      dev('b', 5.0, 20, 0.9), // both edges exactly: kept
      dev('c', 5.0, 19, 1), // too few reviews
      dev('d', 4.99, 500, 0.899), // completion just under
      dev('e', 4.9, 300, 0.97),
    ];
    expect(
      pickDevelopers(list, { devMinCompletion: 90, devMinReviews: 20 }).map((d) => d.username),
    ).toEqual(['b', 'e', 'a']);
  });

  it('on the real answer, every developer kept meets both filters', () => {
    const list = DIRECTORY.result.users.map(normaliseDeveloper);
    const kept = pickDevelopers(list, { devMinCompletion: 98, devMinReviews: 500 });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(list.length);
    for (const d of kept) {
      expect(d.completionRate! * 100).toBeGreaterThanOrEqual(98);
      expect(d.reviews).toBeGreaterThanOrEqual(500);
    }
  });

  it('a shortlisted developer starts with their own rate and no note', () => {
    expect(toShortlist(dev('a', 4.9, 100, 0.95))).toEqual({
      username: 'a',
      profile: '',
      country: null,
      hourlyRateUsd: 20,
      rating: 4.9,
      reviews: 100,
      rateUsd: 20,
      note: '',
    });
  });
});
