import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoney, formatPercent, formatTime } from './format.js';

/** ARB-060: display formats, with every expected value worked by hand (docs/05 section 3). */
const NBSP = ' ';

describe('dates and times in SAST', () => {
  it('shows DD/MM/YYYY', () => {
    expect(formatDate('2026-09-22T10:00:00Z')).toBe('22/09/2026');
  });

  it('rolls over to the next day after 22:00 UTC, because SAST is UTC+2', () => {
    expect(formatDate('2026-12-31T22:30:00Z')).toBe('01/01/2027');
    expect(formatDateTime('2026-12-31T22:30:00Z')).toBe('01/01/2027 00:30');
  });

  it('uses the 24-hour clock', () => {
    expect(formatTime('2026-09-22T15:05:00Z')).toBe('17:05');
  });

  it('has no daylight saving: June and December give the same offset', () => {
    expect(formatTime('2026-06-15T12:00:00Z')).toBe('14:00');
    expect(formatTime('2026-12-15T12:00:00Z')).toBe('14:00');
  });

  it('refuses something that is not a date', () => {
    expect(() => formatDate('next Tuesday')).toThrow(RangeError);
  });
});

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

  it('refuses a fractional amount rather than round money', () => {
    expect(() => formatMoney(12.5, 'ZAR')).toThrow(/whole minor units/);
  });

  it('refuses something that is not a currency code', () => {
    expect(() => formatMoney(100, 'rand')).toThrow(/currency code/);
  });
});

describe('percentages', () => {
  it('uses a decimal comma to match money', () => {
    expect(formatPercent(0.125)).toBe('12,5%');
    expect(formatPercent(0.3, 0)).toBe('30%');
  });
});
