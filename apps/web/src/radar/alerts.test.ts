import { describe, expect, it } from 'vitest';
import { pickAlerts } from './alerts.js';
import type { Project } from './freelancer.js';

/** Which projects raise an alert (LI-PROMPT-BPOMAX-RADAR-20260927, 4.7). */
const NOW = 1_790_500_000_000;
const MIN = 60_000;

const entry = (id: number, total: number, minutesOld: number) => ({
  project: { id, submitted: NOW - minutesOld * MIN } as Project,
  score: { total },
});

describe('pickAlerts', () => {
  const ranked = [
    entry(1, 85, 3),
    entry(2, 70, 14.9), // at the threshold, just under 15 minutes: alerts
    entry(3, 69, 1), // under the threshold
    entry(4, 90, 15), // 15 minutes old is no longer fresh
    entry(5, 100, 0),
  ];

  it('picks projects at or above the threshold, under 15 minutes old', () => {
    const picked = pickAlerts(ranked, { threshold: 70, notified: new Set(), now: NOW });
    expect(picked.map((e) => e.project.id)).toEqual([1, 2, 5]);
  });

  it('never picks a project twice', () => {
    const picked = pickAlerts(ranked, { threshold: 70, notified: new Set([1, 5]), now: NOW });
    expect(picked.map((e) => e.project.id)).toEqual([2]);
  });

  it('follows the owner’s threshold', () => {
    expect(
      pickAlerts(ranked, { threshold: 90, notified: new Set(), now: NOW }).map((e) => e.project.id),
    ).toEqual([5]);
  });
});
