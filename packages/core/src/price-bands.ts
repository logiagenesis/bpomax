/**
 * The weekly price refresh (ARB-514, the owner's audit E-08; docs/01 section E:
 * "price-refresh | weekly | Updates market bands from completed-project data where the API
 * allows; otherwise from owner CSV import").
 *
 * A market band is what a category of work costs to deliver: the estimate worker takes
 * its p50 as the delivery cost when no rate card covers the job (D-029's order). A band
 * from completed projects is worked from what the house organisation's own accepted
 * deliveries actually cost, never from another organisation's (D-083).
 */

/** Fewer accepted deliveries than this in a category and currency make no band (D-083). */
export const MIN_BAND_SAMPLE = 5;

/** Deliveries accepted within this many days count; older prices are left out (D-083). */
export const BAND_LOOKBACK_DAYS = 365;

interface Quartiles {
  readonly p25Minor: bigint;
  readonly p50Minor: bigint;
  readonly p75Minor: bigint;
}

/**
 * The 25th, 50th and 75th percentiles by linear interpolation between the closest ranks:
 * the rule of Postgres's `percentile_cont` and a spreadsheet's PERCENTILE.INC. At
 * quartile q of n sorted values the position is (n − 1) × q ÷ 4; a position between two
 * values takes the share of the gap, rounded half up to the minor unit. All in integers.
 */
export function quartiles(values: readonly bigint[]): Quartiles {
  if (values.length === 0) throw new RangeError('no values to take quartiles of');
  if (values.some((v) => v < 0n)) throw new RangeError('costs cannot be negative');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const at = (q: 1 | 2 | 3): bigint => {
    const scaled = (sorted.length - 1) * q;
    const index = Math.floor(scaled / 4);
    const share = BigInt(scaled % 4);
    const low = sorted[index]!;
    if (share === 0n) return low;
    const high = sorted[index + 1]!;
    return low + ((high - low) * share * 2n + 4n) / 8n;
  };
  return { p25Minor: at(1), p50Minor: at(2), p75Minor: at(3) };
}
