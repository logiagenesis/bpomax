import { describe, expect, it } from 'vitest';
import { bidMetric, bidPeriod, checkBidAllowance } from './allowance.js';

/** ARB-042: the allowance judgement, without a database. Figures are this file's test data. */
const SEPTEMBER = { start: '2026-09-01', resetsOn: '2026-10-01' };

describe('bidPeriod', () => {
  it('is the calendar month in South African time', () => {
    expect(bidPeriod(new Date('2026-09-22T12:00:00Z'))).toEqual(SEPTEMBER);
    // 22:30 UTC on 30 September is 00:30 on 1 October in Johannesburg.
    expect(bidPeriod(new Date('2026-09-30T22:30:00Z'))).toEqual({
      start: '2026-10-01',
      resetsOn: '2026-11-01',
    });
    // 21:59 UTC is still 23:59 SAST, still September.
    expect(bidPeriod(new Date('2026-09-30T21:59:59Z'))).toEqual(SEPTEMBER);
  });

  it('rolls over the year', () => {
    expect(bidPeriod(new Date('2026-12-31T23:00:00Z'))).toEqual({
      start: '2027-01-01',
      resetsOn: '2027-02-01',
    });
  });

  it('names the counter per platform', () => {
    expect(bidMetric('freelancer')).toBe('bids:freelancer');
  });
});

describe('checkBidAllowance', () => {
  const account = { planName: 'Test plan', allowance: 50 };

  it('allows a bid while some allowance is left, and says how much', () => {
    expect(
      checkBidAllowance({ platform: 'freelancer', account, used: 49, period: SEPTEMBER }),
    ).toEqual({ ok: true, used: 49, limit: 50, remaining: 1, period: SEPTEMBER });
  });

  it('refuses when the allowance is used up, naming the count, the plan and the reset day', () => {
    const verdict = checkBidAllowance({
      platform: 'freelancer',
      account,
      used: 50,
      period: SEPTEMBER,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'allowance_reached', used: 50, limit: 50 });
    if (verdict.ok) return;
    expect(verdict.message).toBe(
      'The freelancer bid allowance is used up: 50 of 50 bids this period on the Test plan plan. It resets on 01/10/2026.',
    );
  });

  it('refuses an allowance of nothing, and one already over', () => {
    expect(
      checkBidAllowance({
        platform: 'freelancer',
        account: { ...account, allowance: 0 },
        used: 0,
        period: SEPTEMBER,
      }),
    ).toMatchObject({ ok: false, reason: 'allowance_reached' });
    expect(
      checkBidAllowance({ platform: 'freelancer', account, used: 51, period: SEPTEMBER }),
    ).toMatchObject({ ok: false, reason: 'allowance_reached' });
  });

  it('refuses an allowance nobody has recorded, and points at T-03', () => {
    const verdict = checkBidAllowance({
      platform: 'freelancer',
      account: { planName: null, allowance: null },
      used: 0,
      period: SEPTEMBER,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'allowance_unknown', limit: null });
    if (verdict.ok) return;
    expect(verdict.message).toMatch(/has not been recorded \(docs\/02 T-03/);
    expect(verdict.message).toMatch(/Nothing is submitted until it is/);
  });

  it('refuses when there is no account at all', () => {
    const verdict = checkBidAllowance({
      platform: 'upwork',
      account: null,
      used: 0,
      period: SEPTEMBER,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'no_account' });
    if (verdict.ok) return;
    expect(verdict.message).toMatch(/No upwork account is connected/);
  });
});
