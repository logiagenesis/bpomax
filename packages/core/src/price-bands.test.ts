import { describe, expect, it } from 'vitest';
import { quartiles } from './price-bands.js';

/** ARB-514: the quartiles of a band, each expected figure worked by hand. */
describe('quartiles', () => {
  it('takes the values themselves where the position is whole', () => {
    // n = 5: positions 1, 2, 3.
    expect(quartiles([100n, 200n, 300n, 400n, 1000n])).toEqual({
      p25Minor: 200n,
      p50Minor: 300n,
      p75Minor: 400n,
    });
  });

  it('interpolates between the closest ranks, whatever order the values come in', () => {
    // n = 6: positions 1,25 → 200 + 0,25 × 100 = 225; 2,5 → 350; 3,75 → 475.
    expect(quartiles([600n, 100n, 500n, 200n, 400n, 300n])).toEqual({
      p25Minor: 225n,
      p50Minor: 350n,
      p75Minor: 475n,
    });
  });

  it('rounds a half-cent up', () => {
    // n = 7: positions 1,5 → 101,5 → 102; 3 → 103; 4,5 → 104,5 → 105.
    expect(quartiles([100n, 101n, 102n, 103n, 104n, 105n, 106n])).toEqual({
      p25Minor: 102n,
      p50Minor: 103n,
      p75Minor: 105n,
    });
    // n = 6 on a one-cent gap: 1,25 → 1,25 → 1; 2,5 → 2,5 → 3; 3,75 → 3,75 → 4.
    expect(quartiles([0n, 1n, 2n, 3n, 4n, 5n])).toEqual({
      p25Minor: 1n,
      p50Minor: 3n,
      p75Minor: 4n,
    });
  });

  it('gives one value for all three when there is one', () => {
    expect(quartiles([450_000n])).toEqual({
      p25Minor: 450_000n,
      p50Minor: 450_000n,
      p75Minor: 450_000n,
    });
  });

  it('refuses nothing to work from, or a negative cost', () => {
    expect(() => quartiles([])).toThrow(/no values/);
    expect(() => quartiles([1n, -1n])).toThrow(/negative/);
  });
});
