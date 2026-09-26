import { describe, expect, it } from 'vitest';
import { formatPrice, formatVatRate, vatThousandths, withVat } from './vat.js';

/**
 * ARB-513: rand prices shown with VAT. Every expected figure below is worked by hand:
 * net × (1 + rate), rounded half away from zero to the cent.
 */
describe('withVat', () => {
  it.each([
    // R1 000,00 at 15%: 1 000,00 × 1,15 = 1 150,00.
    [100_000, '15.000', 115_000n],
    // R999,99 at 15%: 999,99 × 1,15 = 1 149,9885 → R1 149,99.
    [99_999, '15.000', 114_999n],
    // R123,45 at 15%: 123,45 × 1,15 = 141,9675 → R141,97.
    [12_345, '15.000', 14_197n],
    // 10 cents at 15%: 11,5 cents → 12 (half away from zero).
    [10, '15.000', 12n],
    // R1 000,00 at 15,5%: 1 155,00.
    [100_000, '15.500', 115_500n],
    // R0,01 at 15%: 1,15 cents → 1.
    [1, '15.000', 1n],
    // A credit is rounded the same way, away from zero: −999,99 × 1,15 → −R1 149,99.
    [-99_999, '15.000', -114_999n],
    [0, '15.000', 0n],
    // No VAT: unchanged.
    [100_000, '0.000', 100_000n],
  ])('%i minor at %s%% is %s', (net, pct, gross) => {
    expect(withVat(net, pct)).toBe(gross);
  });

  it('works on amounts past a float s exact range', () => {
    // 9 007 199 254 740 993 × 1,15 = 10 358 279 142 952 141,95 → …142.
    expect(withVat(9_007_199_254_740_993n, 15)).toBe(10_358_279_142_952_142n);
  });

  it('refuses what is not a rate', () => {
    expect(() => withVat(100, 'fifteen')).toThrow(/not a VAT rate/);
    expect(vatThousandths('-1')).toBeNull();
    expect(vatThousandths('15.0001')).toBeNull();
  });
});

describe('formatPrice', () => {
  // Thousands are grouped with a no-break space (D-024).
  it('shows a rand price with VAT, and the amount without it', () => {
    expect(formatPrice(100_000, 'ZAR', '15.000')).toBe(
      'R1\u00a0150,00 incl. 15% VAT (R1\u00a0000,00 excl.)',
    );
    expect(formatPrice(12_345, 'ZAR', '15.500')).toBe('R142,58 incl. 15,5% VAT (R123,45 excl.)');
  });

  it('leaves a price as stored where no VAT applies, no rate is known, or it is not in rand', () => {
    expect(formatPrice(100_000, 'ZAR', '0.000')).toBe('R1\u00a0000,00');
    expect(formatPrice(100_000, 'ZAR', null)).toBe('R1\u00a0000,00');
    expect(formatPrice(100_000, 'ZAR', undefined)).toBe('R1\u00a0000,00');
    expect(formatPrice(100_000, 'USD', '15.000')).toBe('USD 1\u00a0000,00');
  });

  it('writes the rate as a percentage with a decimal comma', () => {
    expect(formatVatRate('15.000')).toBe('15%');
    expect(formatVatRate('15.500')).toBe('15,5%');
    expect(formatVatRate('7.125')).toBe('7,125%');
  });
});
