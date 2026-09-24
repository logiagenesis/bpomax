import { describe, expect, it } from 'vitest';
import { funnelRate, isReferralCode, validateAffiliate } from './affiliates.js';

/** ARB-430. The commission figures are test values: the real ones are the owner's. */
describe('validateAffiliate', () => {
  it('accepts a code alone, with no email and no commission agreed yet', () => {
    expect(validateAffiliate({ code: ' partner-1 ' })).toEqual({
      ok: true,
      value: { code: 'partner-1', ownerEmail: null, commissionPct: null },
    });
  });

  it('accepts the owner s figure as given, with a decimal comma or point', () => {
    expect(
      validateAffiliate({ code: 'abc', ownerEmail: 'a@example.test', commissionPct: '12,5' }),
    ).toEqual({
      ok: true,
      value: { code: 'abc', ownerEmail: 'a@example.test', commissionPct: '12.500' },
    });
    expect(validateAffiliate({ code: 'abc', commissionPct: 100 }).ok).toBe(true);
    expect(validateAffiliate({ code: 'abc', commissionPct: 0 }).ok).toBe(true);
  });

  it.each([
    [{}, 'code'],
    [{ code: 'ab' }, 'code'],
    [{ code: 'has space' }, 'code'],
    [{ code: 'x'.repeat(41) }, 'code'],
    [{ code: 'abc', ownerEmail: 'nope' }, 'ownerEmail'],
    [{ code: 'abc', commissionPct: '100.1' }, 'commissionPct'],
    [{ code: 'abc', commissionPct: '-1' }, 'commissionPct'],
    [{ code: 'abc', commissionPct: '1.2345' }, 'commissionPct'],
  ])('refuses %j on %s', (input, field) => {
    const result = validateAffiliate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });
});

describe('referral codes and the funnel', () => {
  it('knows a code when it sees one', () => {
    expect(isReferralCode('partner-1')).toBe(true);
    expect(isReferralCode('<script>')).toBe(false);
    expect(isReferralCode(null)).toBe(false);
  });

  it('rounds a rate down to the whole per cent, and has none with nothing under it', () => {
    expect(funnelRate(1, 3)).toBe(33);
    expect(funnelRate(2, 3)).toBe(66);
    expect(funnelRate(0, 0)).toBeNull();
  });
});
