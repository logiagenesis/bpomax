import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  backupFilename,
  backupOf,
  mergeSettings,
  parseBackup,
  readJson,
  restore,
} from './store.js';
import {
  computeTotals,
  monthlyLimitProblem,
  withStatus,
  type BidStatus,
  type LogEntry,
} from './tracker.js';

/**
 * The Bids tab's figures (LI-PROMPT-BPOMAX-RADAR-20260927, 4.5), from a hand-worked log of
 * eleven bids: seven in September 2026 (SAST) and four in August.
 */
const NOW = Date.parse('2026-09-27T06:53:14Z');

function bid(
  n: number,
  over: {
    month: 'sep' | 'aug';
    template: 'A' | 'B' | null;
    score: number;
    status: BidStatus;
    replied: boolean;
    price?: number;
    currency?: string;
    usdRate?: number;
    agreed?: number;
    delivery?: number;
  },
): LogEntry {
  return {
    id: `b${String(n)}`,
    projectId: 1000 + n,
    title: `Project ${String(n)}`,
    url: `https://www.freelancer.com/projects/p${String(n)}`,
    skills: [],
    budget: { min: null, max: null },
    type: 'fixed',
    currency: over.currency ?? 'USD',
    usdRate: over.usdRate ?? 1,
    price: over.price ?? 100,
    days: 7,
    templateId: over.template ? `t${over.template}` : null,
    templateName: over.template ? `Template ${over.template}${n === 1 ? ' v2' : ''}` : null,
    proposal: '',
    score: over.score,
    scoreParts: { skill: 0, budget: 0, fresh: 0, competition: 0 },
    bidCount: 0,
    ageMinutes: 0,
    placedAt:
      over.month === 'sep'
        ? `2026-09-${String(10 + n).padStart(2, '0')}T08:00:00Z`
        : `2026-08-${String(10 + n)}T08:00:00Z`,
    status: over.status,
    replied: over.replied,
    award:
      over.agreed === undefined
        ? null
        : {
            agreedPrice: over.agreed,
            deliveryCostUsd: over.delivery ?? 0,
            developer: null,
            note: '',
          },
  };
}

// Newest first, as the page keeps it.
const LOG: LogEntry[] = [
  bid(1, {
    month: 'sep',
    template: 'A',
    score: 85,
    status: 'awarded',
    replied: true,
    price: 450,
    agreed: 500,
    delivery: 120,
  }),
  bid(2, { month: 'sep', template: 'A', score: 72, status: 'replied', replied: true }),
  bid(3, { month: 'sep', template: 'A', score: 75, status: 'no-reply', replied: false }),
  bid(4, { month: 'sep', template: 'B', score: 55, status: 'lost', replied: true }),
  bid(5, { month: 'sep', template: 'B', score: 45, status: 'sent', replied: false }),
  bid(6, {
    month: 'sep',
    template: 'B',
    score: 30,
    status: 'awarded',
    replied: true,
    currency: 'INR',
    usdRate: 0.010436,
    price: 7500,
    agreed: 10000,
  }),
  bid(7, { month: 'sep', template: null, score: 20, status: 'sent', replied: false }),
  bid(8, {
    month: 'aug',
    template: 'A',
    score: 90,
    status: 'awarded',
    replied: true,
    currency: 'AUD',
    usdRate: 0.7,
    price: 1800,
    agreed: 2000,
    delivery: 600,
  }),
  bid(9, { month: 'aug', template: 'B', score: 65, status: 'replied', replied: true }),
  bid(10, { month: 'aug', template: 'A', score: 40, status: 'lost', replied: false }),
  bid(11, { month: 'aug', template: 'B', score: 10, status: 'no-reply', replied: false }),
];

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  ratio: denominator ? numerator / denominator : null,
});

describe('computeTotals, hand-worked', () => {
  const { month, all } = computeTotals(LOG, { feePct: 10, usdToZar: 18 }, NOW);

  it('this month: 7 bids, 4 replies (1, 2, 4, 6), 2 awards (1, 6)', () => {
    expect(month.bids).toBe(7);
    expect(month.replies).toBe(4);
    expect(month.replyRate).toEqual(rate(4, 7));
    expect(month.awards).toBe(2);
    expect(month.winRate).toEqual(rate(2, 4));
  });

  it('this month’s money: USD 500 + INR 10 000 × 0,010436 = USD 604,36; less 120 and a 10 % fee', () => {
    expect(month.awardedUsd).toBeCloseTo(604.36, 6);
    expect(month.deliveryUsd).toBe(120);
    expect(month.feeUsd).toBeCloseTo(60.436, 6);
    // 604,36 − 120 − 60,436 = 423,924
    expect(month.marginUsd).toBeCloseTo(423.924, 6);
    expect(month.zar!.awarded).toBeCloseTo(10878.48, 6);
    expect(month.zar!.delivery).toBeCloseTo(2160, 6);
    expect(month.zar!.margin).toBeCloseTo(7630.632, 6);
  });

  it('this month by template: A 3 bids 2 replies 1 award; B 3, 2, 1; none 1, 0, 0', () => {
    expect(month.byTemplate).toEqual([
      {
        key: 'tA',
        name: 'Template A v2',
        bids: 3,
        replies: 2,
        awards: 1,
        replyRate: rate(2, 3),
        winRate: rate(1, 2),
      },
      {
        key: 'tB',
        name: 'Template B',
        bids: 3,
        replies: 2,
        awards: 1,
        replyRate: rate(2, 3),
        winRate: rate(1, 2),
      },
      {
        key: 'none',
        name: 'No template',
        bids: 1,
        replies: 0,
        awards: 0,
        replyRate: rate(0, 1),
        winRate: rate(0, 0),
      },
    ]);
  });

  it('this month by rank band: 0–39 is bids 6 and 7; 40–69 is 4 and 5; 70–100 is 1, 2 and 3', () => {
    expect(month.byBand.map((b) => [b.name, b.bids, b.replies, b.awards])).toEqual([
      ['0–39', 2, 1, 1],
      ['40–69', 2, 1, 0],
      ['70–100', 3, 2, 1],
    ]);
  });

  it('all time: 11 bids, 6 replies, 3 awards; USD 604,36 + AUD 2 000 × 0,7 = USD 2 004,36', () => {
    expect(all.bids).toBe(11);
    expect(all.replyRate).toEqual(rate(6, 11));
    expect(all.awards).toBe(3);
    expect(all.winRate).toEqual(rate(3, 6));
    expect(all.awardedUsd).toBeCloseTo(2004.36, 6);
    expect(all.deliveryUsd).toBe(720);
    expect(all.feeUsd).toBeCloseTo(200.436, 6);
    // 2 004,36 − 720 − 200,436 = 1 083,924
    expect(all.marginUsd).toBeCloseTo(1083.924, 6);
  });

  it('all time by template and band', () => {
    expect(all.byTemplate.map((t) => [t.name, t.bids, t.replies, t.awards])).toEqual([
      ['Template A v2', 5, 3, 2],
      ['Template B', 5, 3, 1],
      ['No template', 1, 0, 0],
    ]);
    expect(all.byBand.map((b) => [b.name, b.bids, b.replies, b.awards])).toEqual([
      ['0–39', 3, 1, 1],
      ['40–69', 4, 2, 0],
      ['70–100', 4, 3, 2],
    ]);
  });

  it('with no fee % set, the margin leaves the fee out and says it is not set; no rate, no ZAR', () => {
    const t = computeTotals(LOG, { feePct: null, usdToZar: null }, NOW).month;
    expect(t.feeUsd).toBeNull();
    expect(t.marginUsd).toBeCloseTo(484.36, 6);
    expect(t.zar).toBeNull();
  });

  it('an empty log gives zeros and rates with no data', () => {
    const t = computeTotals([], { feePct: 10, usdToZar: null }, NOW).all;
    expect(t).toMatchObject({ bids: 0, replies: 0, awards: 0, awardedUsd: 0, marginUsd: 0 });
    expect(t.replyRate.ratio).toBeNull();
    expect(t.winRate.ratio).toBeNull();
    expect(t.byBand.map((b) => b.bids)).toEqual([0, 0, 0]);
  });
});

describe('the status buttons', () => {
  const sent = LOG[6]!;

  it('Replied and Awarded mark a reply; an award starts at the bid’s price and no cost', () => {
    expect(withStatus(sent, 'replied')).toMatchObject({
      status: 'replied',
      replied: true,
      award: null,
    });
    expect(withStatus(sent, 'awarded')).toMatchObject({
      status: 'awarded',
      replied: true,
      award: { agreedPrice: 100, deliveryCostUsd: 0, developer: null, note: '' },
    });
  });

  it('Lost keeps whether there was a reply; No reply and back to sent clear it', () => {
    expect(withStatus(withStatus(sent, 'replied'), 'lost')).toMatchObject({
      status: 'lost',
      replied: true,
    });
    expect(withStatus(sent, 'lost')).toMatchObject({ status: 'lost', replied: false });
    expect(withStatus(withStatus(sent, 'replied'), 'no-reply').replied).toBe(false);
    expect(withStatus(withStatus(sent, 'replied'), 'sent')).toMatchObject({
      status: 'sent',
      replied: false,
    });
  });

  it('keeps award figures typed in when the status moves away and back', () => {
    const awarded = { ...withStatus(sent, 'awarded') };
    awarded.award = { ...awarded.award!, agreedPrice: 90, deliveryCostUsd: 30 };
    const back = withStatus(withStatus(awarded, 'sent'), 'awarded');
    expect(back.award).toEqual({ agreedPrice: 90, deliveryCostUsd: 30, developer: null, note: '' });
    // Only an awarded bid counts towards the money.
    expect(
      computeTotals([withStatus(awarded, 'lost')], { feePct: null, usdToZar: null }, NOW).all
        .awardedUsd,
    ).toBe(0);
  });
});

describe('Export and Import', () => {
  afterEach(() => vi.unstubAllGlobals());

  const state = {
    settings: mergeSettings({ pricePct: 55, monthlyLimit: 300 }),
    templates: [{ id: 't1', name: 'Short', body: 'Hi {title}', isDefault: true }],
    log: LOG,
    dismissed: [40735846, 40735227],
    shortlist: [{ username: 'usatechsoft', note: 'WordPress', rate: 35 }],
  };

  it('round-trips everything: settings, templates, log, dismissed and shortlist', () => {
    const file = JSON.stringify(backupOf(state, NOW));
    const back = parseBackup(file);
    expect(back).toEqual({
      format: 'radar-backup',
      version: 1,
      exportedAt: '2026-09-27T06:53:14.000Z',
      ...state,
    });

    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    expect(restore(back)).toBe(true);
    expect([...data.keys()].sort()).toEqual([
      'radar.dismissed',
      'radar.log',
      'radar.settings',
      'radar.shortlist',
      'radar.templates',
    ]);
    expect(readJson('log', [])).toEqual(LOG);
    expect(mergeSettings(readJson('settings', null))).toEqual(state.settings);
  });

  it('fills settings a backup predates with their defaults', () => {
    const old = { ...backupOf(state, NOW), settings: { pricePct: 50 } };
    expect(parseBackup(JSON.stringify(old)).settings).toEqual({
      ...DEFAULT_SETTINGS,
      pricePct: 50,
    });
  });

  it('refuses anything that is not a backup, and says why', () => {
    expect(() => parseBackup('not json')).toThrow(
      'That file is not a radar backup: it is not JSON.',
    );
    expect(() => parseBackup('{"format":"other"}')).toThrow('That file is not a radar backup.');
    expect(() => parseBackup('{"format":"radar-backup","version":2}')).toThrow(
      'That backup is version 2; this page reads version 1.',
    );
    const noLog = { ...backupOf(state, NOW), log: undefined };
    expect(() => parseBackup(JSON.stringify(noLog))).toThrow('That backup has no log list.');
    const badIds = { ...backupOf(state, NOW), dismissed: ['x'] };
    expect(() => parseBackup(JSON.stringify(badIds))).toThrow(
      'dismissed list is not project numbers',
    );
  });

  it('is named by the SAST date: radar-backup-DD-MM-YYYY.json', () => {
    expect(backupFilename(NOW)).toBe('radar-backup-27-09-2026.json');
    // 23:30 UTC on 30/09 is already 01/10 in SAST.
    expect(backupFilename(Date.parse('2026-09-30T23:30:00Z'))).toBe('radar-backup-01-10-2026.json');
  });
});

describe('the monthly limit on Place now (R-06)', () => {
  const at = (placedAt: string) => ({ placedAt }) as LogEntry;
  // Three bids in September 2026 SAST (the last at 23:59 SAST on the 30th) and one at
  // 00:00 SAST on 1 October, which belongs to October.
  const log = [
    at('2026-09-03T08:00:00Z'),
    at('2026-09-27T06:53:14Z'),
    at('2026-09-30T21:59:00Z'),
    at('2026-09-30T22:00:00Z'),
  ];
  const IN_SEPTEMBER = Date.parse('2026-09-28T10:00:00Z');
  const IN_OCTOBER = Date.parse('2026-10-01T08:00:00Z');

  it('has no check when the limit is blank', () => {
    expect(monthlyLimitProblem(log, null, IN_SEPTEMBER)).toBeNull();
  });

  it('allows a bid while the month’s count is under the limit: 3 logged, limit 4', () => {
    expect(monthlyLimitProblem(log, 4, IN_SEPTEMBER)).toBeNull();
  });

  it('refuses at the limit, with the count: 3 logged, limit 3', () => {
    expect(monthlyLimitProblem(log, 3, IN_SEPTEMBER)).toBe(
      'The monthly limit in Settings is reached (3 of 3 bids logged this month), so Place now is off.',
    );
  });

  it('refuses over the limit too: 3 logged, limit 2', () => {
    expect(monthlyLimitProblem(log, 2, IN_SEPTEMBER)).toBe(
      'The monthly limit in Settings is reached (3 of 2 bids logged this month), so Place now is off.',
    );
  });

  it('counts only the SAST month now falls in: October has 1 bid, so a limit of 2 is open', () => {
    expect(monthlyLimitProblem(log, 2, IN_OCTOBER)).toBeNull();
    expect(monthlyLimitProblem(log, 1, IN_OCTOBER)).toBe(
      'The monthly limit in Settings is reached (1 of 1 bids logged this month), so Place now is off.',
    );
  });
});
