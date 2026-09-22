import { describe, expect, it } from 'vitest';
import { formatMoney, formatPercent } from './money.js';

/** D-024's format, held to the same outputs as apps/web/src/lib/format.test.ts. */
const NBSP = ' ';

describe('money from minor units', () => {
  it.each([
    [123456, 'ZAR', `R1${NBSP}234,56`],
    [5, 'ZAR', 'R0,05'],
    [0, 'ZAR', 'R0,00'],
    [-250000, 'ZAR', `-R2${NBSP}500,00`],
    [123456789012, 'ZAR', `R1${NBSP}234${NBSP}567${NBSP}890,12`],
    [99999, 'usd', `USD 999,99`],
    [1500, 'JPY', `JPY 1${NBSP}500`],
    [1234, 'KWD', 'KWD 1,234'],
  ])('%d %s is %s', (minor, currency, expected) => {
    expect(formatMoney(minor, currency)).toBe(expected);
  });

  it('handles amounts beyond the float range exactly, as bigint', () => {
    expect(formatMoney(9_007_199_254_740_993n, 'ZAR')).toBe(
      `R90${NBSP}071${NBSP}992${NBSP}547${NBSP}409,93`,
    );
  });

  it('refuses a fractional amount and a non-currency', () => {
    expect(() => formatMoney(12.5, 'ZAR')).toThrow(/whole minor units/);
    expect(() => formatMoney(100, 'rand')).toThrow(/currency code/);
  });

  it('writes percentages with a decimal comma', () => {
    expect(formatPercent(0.125)).toBe('12,5%');
    expect(formatPercent(0.4, 0)).toBe('40%');
  });
});
