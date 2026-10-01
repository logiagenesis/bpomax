/** @typedef {{revenue:number, vendor:number, rework:number, fees:number, acquisition:number, labour:number, tools:number, fixed:number, fx:number, refunds:number, overhead:number, target:number}} Scenario */

/** @type {Scenario} */
export const example = {
  revenue: 20000,
  vendor: 8000,
  rework: 10,
  fees: 10,
  acquisition: 1000,
  labour: 2000,
  tools: 300,
  fixed: 200,
  fx: 3,
  refunds: 500,
  overhead: 1500,
  target: 20,
};

/**
 * Planning amounts share one tax-exclusive currency. Rates are scenario assumptions.
 * No provider-specific fee schedule or actual cash reconciliation is implied.
 * @param {Scenario} s
 */
export function calculate(s) {
  if (
    Object.keys(example).some((key) => {
      const v = s[/** @type {keyof Scenario} */ (key)];
      return typeof v !== 'number' || !Number.isFinite(v) || v < 0;
    })
  ) {
    throw new Error('Complete every field with a finite, non-negative amount.');
  }
  if (s.revenue <= 0) throw new Error('Revenue must be greater than zero to calculate a margin.');
  if ([s.rework, s.fees, s.fx, s.target].some((v) => v > 100)) {
    throw new Error('Percentage assumptions must be between 0 and 100.');
  }
  const denominator = 1 - (s.fees + s.fx + s.target) / 100;
  if (denominator <= 0) {
    throw new Error('Fees, FX reserve and target margin together must be below 100%.');
  }
  const reworkCost = (s.vendor * s.rework) / 100;
  const fixedCost =
    s.vendor + reworkCost + s.acquisition + s.labour + s.tools + s.fixed + s.refunds;
  const variableCost = (s.revenue * (s.fees + s.fx)) / 100;
  const contribution = s.revenue - fixedCost - variableCost;
  const surplus = contribution - s.overhead;
  return {
    contribution,
    surplus,
    reworkCost,
    contributionMargin: (contribution / s.revenue) * 100,
    operatingMargin: (surplus / s.revenue) * 100,
    minimumQuote: (fixedCost + s.overhead) / denominator,
    totalCost: fixedCost + variableCost + s.overhead,
    targetMet: (surplus / s.revenue) * 100 + 1e-9 >= s.target,
  };
}
