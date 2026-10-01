import { describe, expect, it } from 'vitest';
import { calculate, example } from './economics.js';

describe('tax-exclusive project planning', () => {
  it('accounts for fees, reserves, unsuccessful acquisition allocation, labour and overhead', () => {
    const result = calculate(example);
    expect(result.contribution).toBe(4600);
    expect(result.surplus).toBe(3100);
    expect(result.operatingMargin).toBe(15.5);
    expect(result.minimumQuote).toBeCloseTo(14300 / 0.67);
    expect(result.targetMet).toBe(false);
  });
  it('includes the linked increase in rework when supplier cost rises', () => {
    expect(calculate({ ...example, vendor: 10000 }).surplus).toBe(900);
  });
  it('retains losses instead of clipping them to zero', () => {
    expect(calculate({ ...example, revenue: 5000 }).surplus).toBeLessThan(0);
  });
  it('prices to the selected operating target under the same assumptions', () => {
    const quote = calculate(example).minimumQuote;
    expect(calculate({ ...example, revenue: quote }).operatingMargin).toBeCloseTo(20);
    expect(calculate({ ...example, revenue: quote }).targetMet).toBe(true);
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid revenue %s', (revenue) => {
    expect(() => calculate({ ...example, revenue })).toThrow();
  });
  it('does not treat missing supplier cost as zero', () => {
    expect(() => calculate({ ...example, vendor: NaN })).toThrow();
  });
  it('rejects impossible percentage and target assumptions', () => {
    expect(() => calculate({ ...example, fees: 101 })).toThrow();
    expect(() => calculate({ ...example, fees: 80, target: 20, fx: 3 })).toThrow();
  });
});
