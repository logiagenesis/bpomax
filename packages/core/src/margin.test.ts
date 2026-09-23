import { describe, expect, it } from 'vitest';
import {
  HOME_CURRENCY,
  convertMinor,
  divRoundHalfUp,
  evaluateMargin,
  feeOn,
  findFeeRule,
  parseDecimal,
  parseFeeTable,
  percentOf,
  percentageOf,
  type FeeRule,
  type FxQuote,
  type MarginInputs,
} from './margin.js';

/**
 * ARB-041 acceptance: "Hand-calculated test cases pass to the cent for fixed, hourly,
 * multi-currency". Every expected value below is worked in the comment beside it. The
 * percentages and rates are this file's test data, not anyone's fee schedule (docs/02 T-02,
 * D-02, D-03 are still open); the arithmetic is what is under test.
 */
const TEN_PERCENT: FeeRule = {
  platform: 'freelancer',
  projectType: 'fixed',
  side: 'freelancer',
  percent: 10,
  minMinor: 500,
  minCurrency: 'USD',
  sourceUrl: 'https://example.test/fees',
  readOn: '2026-09-22',
};

/** USD 1 = ZAR 18.25, test data. */
const USD_ZAR: FxQuote = {
  rate: '18.25',
  from: 'USD',
  to: 'ZAR',
  at: '2026-09-22T12:00:00.000Z',
  source: 'test',
};

function inputs(fields: Partial<MarginInputs>): MarginInputs {
  return {
    currency: 'ZAR',
    hourly: false,
    clientBudgetMinor: 500_000,
    supplierCostMinor: 250_000,
    toolCostMinor: 0,
    fee: TEN_PERCENT,
    feeMinimumMinor: null,
    fxBufferPercent: 3,
    minMarginPercent: 20,
    minMarginHomeMinor: 50_000,
    fxToHome: null,
    ...fields,
  };
}

describe('the arithmetic', () => {
  it('rounds half away from zero, so a half-cent is never lost', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(/positive denominator/);
  });

  it('takes a percentage in whole minor units', () => {
    expect(percentOf(12_345, 10)).toBe(1_235); // 1 234.5 → 1 235
    expect(percentOf(12_344, 10)).toBe(1_234); // 1 234.4 → 1 234
    expect(percentOf(1_000, 2.5)).toBe(25);
    expect(percentOf(1, 0.001)).toBe(0);
    expect(percentOf(100, 0)).toBe(0);
    expect(() => percentOf(1.5, 10)).toThrow(/whole minor units/);
  });

  it('takes a fee as the percentage or the minimum, whichever is more (ARB-204)', () => {
    // 3% of R900,00 is R27,00, above a R10,00 minimum; 3% of R200,00 is R6,00, below it.
    expect(feeOn(90_000, { percent: 3 }, 1_000)).toEqual({
      feeMinor: 2_700,
      minimumApplied: false,
    });
    expect(feeOn(20_000, { percent: 3 }, 1_000)).toEqual({ feeMinor: 1_000, minimumApplied: true });
    expect(feeOn(20_000, { percent: 3 }, null)).toEqual({ feeMinor: 600, minimumApplied: false });
  });

  it('parses a decimal exactly, and refuses more decimals than the scale keeps', () => {
    expect(parseDecimal('18.25', 8)).toBe(1_825_000_000n);
    expect(parseDecimal('-0.5', 3)).toBe(-500n);
    expect(parseDecimal('7', 2)).toBe(700n);
    expect(() => parseDecimal('1.123456789', 8)).toThrow(/more than 8 decimals/);
    expect(() => parseDecimal('1e3', 8)).toThrow(/not a decimal/);
  });

  it('converts at the rate to the cent', () => {
    expect(convertMinor(84_000, USD_ZAR)).toBe(1_533_000); // 840.00 × 18.25 = 15 330.00
    expect(convertMinor(1_915, USD_ZAR)).toBe(34_949); // 19.15 × 18.25 = 349.4875 → 349.49
    expect(convertMinor(-30_000, USD_ZAR)).toBe(-547_500);
    expect(() => convertMinor(1, { ...USD_ZAR, rate: '0' })).toThrow(/positive/);
  });

  it('gives a percentage with three decimals', () => {
    expect(percentageOf(1_915, 4_500)).toBe('42.556'); // 42.5555…
    expect(percentageOf(-30_000, 100_000)).toBe('-30.000');
    expect(percentageOf(1, 3)).toBe('33.333');
    expect(percentageOf(5, 0)).toBe('0.000');
  });
});

describe('a fixed-price deal in ZAR', () => {
  // Budget R5 000,00; fee 10% = R500,00; supplier R2 500,00; no FX buffer at home; no
  // tool cost. Margin = 5 000 − 500 − 2 500 = R2 000,00 = 40.000%. Rules: 20% and R500.
  const result = evaluateMargin(inputs({}));

  it('stores every line and passes', () => {
    expect(result).toMatchObject({
      currency: 'ZAR',
      clientBudgetMinor: 500_000,
      platformFeeMinor: 50_000,
      feeMinimumApplied: false,
      supplierCostMinor: 250_000,
      fxBufferMinor: 0,
      toolCostMinor: 0,
      marginMinor: 200_000,
      marginPercent: '40.000',
      marginHomeMinor: 200_000,
      absoluteRuleApplied: true,
      passed: true,
    });
    expect(result.reason).toBe('margin ZAR 2000.00 (40.000%) clears the rules');
  });

  it('names the lowest price that still clears both rules', () => {
    // Margin at price P is P − 10% − 250 000; the rule wants 20% of P and R500.
    // 0.7P ≥ 250 000 → P ≥ 357 142.86, but rounding decides the cent:
    //   357 142: fee 35 714.2 → 35 714; margin 71 428; 20% = 71 428.4 → 71 428 → clears
    //   357 141: fee 35 714.1 → 35 714; margin 71 427; 20% = 71 428.2 → 71 428 → short
    expect(result.requiredPriceMinor).toBe(357_142);
  });
});

describe('a fixed-price deal in USD', () => {
  // Budget USD 2 000,00; fee 10% = 200,00 (above the USD 5,00 minimum); supplier 900,00;
  // FX buffer 3% of the budget = 60,00. Margin = 2 000 − 200 − 900 − 60 = USD 840,00 =
  // 42.000%. At 18.25 that is ZAR 15 330,00, above the R500 minimum.
  const result = evaluateMargin(
    inputs({
      currency: 'USD',
      clientBudgetMinor: 200_000,
      supplierCostMinor: 90_000,
      feeMinimumMinor: 500,
      fxToHome: USD_ZAR,
    }),
  );

  it('applies the buffer, converts the margin, and passes', () => {
    expect(result).toMatchObject({
      platformFeeMinor: 20_000,
      feeMinimumApplied: false,
      fxBufferMinor: 6_000,
      marginMinor: 84_000,
      marginPercent: '42.000',
      marginHomeMinor: 1_533_000,
      passed: true,
    });
  });

  it('names the lowest clearing price, with the buffer in the slope', () => {
    // Margin at P is P − 10% − 3% − 90 000 against 20% of P: 0.67P ≥ 90 000 → 134 328.36.
    //   134 329: fee 13 433, buffer 4 029.87 → 4 030, margin 26 866; 20% = 26 865.8 → 26 866 → clears
    //   134 328: fee 13 433, buffer 4 029.84 → 4 030, margin 26 865; 20% = 26 865.6 → 26 866 → short
    expect(result.requiredPriceMinor).toBe(134_329);
  });

  it('applies the platform s minimum fee when the percentage is below it', () => {
    // Budget USD 30,00: 10% is 3,00, so the USD 5,00 minimum applies. Buffer 3% = 0,90.
    // Margin = 30,00 − 5,00 − 10,00 − 0,90 = USD 14,10 = 47.000%; ZAR 257,325 → 257,33,
    // below the R500 minimum.
    const small = evaluateMargin(
      inputs({
        currency: 'USD',
        clientBudgetMinor: 3_000,
        supplierCostMinor: 1_000,
        feeMinimumMinor: 500,
        fxToHome: USD_ZAR,
      }),
    );
    expect(small).toMatchObject({
      platformFeeMinor: 500,
      feeMinimumApplied: true,
      fxBufferMinor: 90,
      marginMinor: 1_410,
      marginPercent: '47.000',
      marginHomeMinor: 25_733,
      passed: false,
    });
    expect(small.reason).toBe('margin ZAR 257.33 is below the ZAR 500.00 minimum');
  });

  it('refuses to judge a foreign deal without a rate, or with the wrong pair', () => {
    expect(() => evaluateMargin(inputs({ currency: 'USD' }))).toThrow(/needs a rate to ZAR/);
    expect(() => evaluateMargin(inputs({ currency: 'EUR', fxToHome: USD_ZAR }))).toThrow(
      /USD→ZAR, not EUR→ZAR/,
    );
    expect(HOME_CURRENCY).toBe('ZAR');
  });
});

describe('an hourly deal in USD', () => {
  // USD 45,00 per hour; fee 10% = 4,50; supplier 20,00 per hour; buffer 3% = 1,35.
  // Margin = 45,00 − 4,50 − 20,00 − 1,35 = USD 19,15 per hour = 42.5555…% → 42.556%.
  const result = evaluateMargin(
    inputs({
      currency: 'USD',
      hourly: true,
      clientBudgetMinor: 4_500,
      supplierCostMinor: 2_000,
      fee: { ...TEN_PERCENT, projectType: 'hourly', minMinor: null, minCurrency: null },
      fxToHome: USD_ZAR,
    }),
  );

  it('judges the percentage only: the ZAR minimum is per job, not per hour', () => {
    expect(result).toMatchObject({
      platformFeeMinor: 450,
      fxBufferMinor: 135,
      marginMinor: 1_915,
      marginPercent: '42.556',
      marginHomeMinor: null,
      absoluteRuleApplied: false,
      passed: true,
    });
    expect(result.reason).toBe(
      'margin USD 19.15 per hour (42.556%) clears the rules; the ZAR minimum is per job and is not applied per hour',
    );
  });

  it('names the lowest clearing hourly rate, judged on the percentage alone', () => {
    // Margin at rate P is P − 10% − 3% − 2 000 against 20% of P: 0.67P ≥ 2 000 → 2 985.07.
    //   2 986: fee 298.6 → 299, buffer 89.58 → 90, margin 597; 20% = 597.2 → 597 → clears
    //   2 985: fee 298.5 → 299, buffer 89.55 → 90, margin 596; 20% = 597.0 → 597 → short
    // Were the R500 minimum applied per hour, no rate near this would clear.
    expect(result.requiredPriceMinor).toBe(2_986);
  });
});

describe('the edges of the rules', () => {
  it('counts tool costs as a line of their own', () => {
    // As the ZAR case, less R100,00 of tool cost: margin R1 900,00 = 38.000%.
    const result = evaluateMargin(inputs({ toolCostMinor: 10_000 }));
    expect(result).toMatchObject({
      toolCostMinor: 10_000,
      marginMinor: 190_000,
      marginPercent: '38.000',
    });
  });

  it('passes a margin that meets a rule exactly', () => {
    // R1 000,00 budget, fee R100,00, supplier R700,00 → margin R200,00 = 20.000%, which is
    // the minimum, against a R200,00 minimum amount: both met, neither exceeded.
    const result = evaluateMargin(
      inputs({ clientBudgetMinor: 100_000, supplierCostMinor: 70_000, minMarginHomeMinor: 20_000 }),
    );
    expect(result).toMatchObject({ marginMinor: 20_000, marginPercent: '20.000', passed: true });
    expect(result.requiredPriceMinor).toBe(100_000);
  });
});

describe('deals that fail', () => {
  it('on the percentage, and says by how much', () => {
    // R1 000,00 budget, fee R100,00, supplier R750,00 → margin R150,00 = 15.000% < 20%.
    const result = evaluateMargin(
      inputs({ clientBudgetMinor: 100_000, supplierCostMinor: 75_000 }),
    );
    expect(result).toMatchObject({ marginMinor: 15_000, marginPercent: '15.000', passed: false });
    // R150,00 is also under the R500 minimum, so both shortfalls are named.
    expect(result.reason).toBe(
      'margin 15.000% is below the 20.000% minimum; margin ZAR 150.00 is below the ZAR 500.00 minimum',
    );
    // The lowest clearing price must satisfy both rules. The R500 minimum is the binding
    // one here: 0.9P − 75 000 ≥ 50 000 → P ≥ 138 888.9.
    //   138 889: fee 13 888.9 → 13 889; margin 50 000 → clears (20% = 27 778 is also met)
    //   138 888: fee 13 888.8 → 13 889; margin 49 999 → short
    expect(result.requiredPriceMinor).toBe(138_889);
  });

  it('on the ZAR minimum even when the percentage is fine', () => {
    // R200,00 budget, fee R20,00, supplier R120,00 → margin R60,00 = 30.000%, under R500.
    const result = evaluateMargin(inputs({ clientBudgetMinor: 20_000, supplierCostMinor: 12_000 }));
    expect(result).toMatchObject({ marginMinor: 6_000, marginPercent: '30.000', passed: false });
    expect(result.reason).toBe('margin ZAR 60.00 is below the ZAR 500.00 minimum');
  });

  it('with a negative margin, naming both shortfalls', () => {
    const result = evaluateMargin(
      inputs({ clientBudgetMinor: 100_000, supplierCostMinor: 120_000 }),
    );
    expect(result).toMatchObject({ marginMinor: -30_000, marginPercent: '-30.000', passed: false });
    expect(result.reason).toBe(
      'margin -30.000% is below the 20.000% minimum; margin -ZAR 300.00 is below the ZAR 500.00 minimum',
    );
  });

  it('with no price that could ever clear, when the percentages leave nothing', () => {
    const result = evaluateMargin(
      inputs({
        currency: 'USD',
        fee: { ...TEN_PERCENT, percent: 60, minMinor: null, minCurrency: null },
        fxBufferPercent: 30,
        minMarginPercent: 20,
        fxToHome: USD_ZAR,
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.requiredPriceMinor).toBeNull();
  });

  it('refuses inputs that are not whole minor units', () => {
    expect(() => evaluateMargin(inputs({ clientBudgetMinor: -1 }))).toThrow(/clientBudgetMinor/);
    expect(() => evaluateMargin(inputs({ supplierCostMinor: 10.5 }))).toThrow(/supplierCostMinor/);
  });
});

describe('the fee table', () => {
  const good = {
    platform: 'freelancer',
    project_type: 'fixed',
    side: 'freelancer',
    percent: 10,
    min_minor: 500,
    min_currency: 'USD',
    source_url: 'https://example.test/fees',
    read_on: '2026-09-22',
  };

  it('reads rules that carry their source and date', () => {
    const parsed = parseFeeTable([good, { ...good, project_type: 'hourly', min_minor: null }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);
    expect(parsed.value[0]).toEqual(TEN_PERCENT);
    expect(parsed.value[1]).toMatchObject({
      projectType: 'hourly',
      minMinor: null,
      minCurrency: null,
    });
    expect(findFeeRule(parsed.value, 'freelancer', 'hourly', 'freelancer')?.projectType).toBe(
      'hourly',
    );
    expect(findFeeRule(parsed.value, 'upwork', 'fixed', 'freelancer')).toBeNull();
  });

  it('refuses a rule without provenance, an impossible percentage, or a repeat', () => {
    const cases: [Record<string, unknown> | unknown, RegExp][] = [
      [{ ...good, source_url: undefined }, /source_url/],
      [{ ...good, read_on: 'yesterday' }, /read_on/],
      [{ ...good, percent: 101 }, /percent.*0 to 100/],
      [{ ...good, percent: 10.1234 }, /three decimals/],
      [{ ...good, min_currency: 'dollars' }, /min_currency/],
      [{ ...good, min_minor: 5.5 }, /min_minor/],
      [{ ...good, extra: 1 }, /not a field/],
      [{ ...good, platform: 'peopleperhour' }, /platform/],
    ];
    for (const [entry, expected] of cases) {
      const parsed = parseFeeTable([entry]);
      expect(parsed.ok, JSON.stringify(entry)).toBe(false);
      if (!parsed.ok)
        expect(parsed.errors.map((e) => `${e.field} ${e.message}`).join('\n')).toMatch(expected);
    }
    const twice = parseFeeTable([good, good]);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.errors[0]?.message).toMatch(/repeats the rule/);
    expect(parseFeeTable({}).ok).toBe(false);
    expect(parseFeeTable(['x']).ok).toBe(false);
  });
});
