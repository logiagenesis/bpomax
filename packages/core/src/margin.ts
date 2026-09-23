import { PLATFORMS, type FieldError, type Platform, type ValidationResult } from './scanners.js';

/**
 * The margin engine (ARB-041, docs/01 sections E and G):
 *
 *   margin = client budget − platform fee − supplier cost − FX buffer − tool costs
 *
 * compared with the org's rules: a minimum margin percentage and a minimum margin amount
 * in ZAR. Every line is returned so the worker can store it (05 section 3.3), and every
 * sum is done in whole minor units with BigInt, never in floating point (05 section 3.2).
 *
 * Nothing in here is a figure. The fee percentages come from the org's fee table, entered
 * from the platform's official fee page with its URL and date (05 section 5.2, docs/02
 * T-02); the buffer and the minimums are the owner's (D-02, D-03). Where a rule is
 * missing the worker records that it is missing; this module is never given a default.
 */

/** The margin rules are set in ZAR (01 section G), so ZAR is the currency margins are judged in. */
export const HOME_CURRENCY = 'ZAR';

export const PROJECT_TYPES = ['fixed', 'hourly'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Which side of a platform pays the fee: us bidding as a freelancer, or us posting as an employer. */
export const FEE_SIDES = ['freelancer', 'employer'] as const;
export type FeeSide = (typeof FEE_SIDES)[number];

export interface FeeRule {
  readonly platform: Platform;
  readonly projectType: ProjectType;
  readonly side: FeeSide;
  /** Percentage of the amount, e.g. 10 for 10%. At most three decimals. */
  readonly percent: number;
  /** The platform's minimum fee when it has one, in minor units of `minCurrency`. */
  readonly minMinor: number | null;
  readonly minCurrency: string | null;
  /** The official fee page the figures were read from, and the day they were read. */
  readonly sourceUrl: string;
  readonly readOn: string;
}

const FEE_TABLE_KEYS = new Set([
  'platform',
  'project_type',
  'side',
  'percent',
  'min_minor',
  'min_currency',
  'source_url',
  'read_on',
]);

const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Reads `settings.fee_table` (a JSON array) into fee rules, or says exactly what is wrong
 * with each entry. A rule without its source page and date is refused: a fee figure with
 * no provenance is a guess (05 section 5.2).
 */
export function parseFeeTable(input: unknown): ValidationResult<FeeRule[]> {
  const errors: FieldError[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an array of fee rules' }] };
  }
  const rules: FeeRule[] = [];
  const seen = new Set<string>();

  input.forEach((entry: unknown, index) => {
    const at = (field: string) => `[${String(index)}].${field}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push({ field: `[${String(index)}]`, message: 'must be an object' });
      return;
    }
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!FEE_TABLE_KEYS.has(key))
        errors.push({ field: at(key), message: 'is not a field on a fee rule' });
    }
    const before = errors.length;

    if (!PLATFORMS.includes(raw.platform as Platform)) {
      errors.push({ field: at('platform'), message: `must be one of ${PLATFORMS.join(', ')}` });
    }
    if (!PROJECT_TYPES.includes(raw.project_type as ProjectType)) {
      errors.push({
        field: at('project_type'),
        message: `must be one of ${PROJECT_TYPES.join(', ')}`,
      });
    }
    if (!FEE_SIDES.includes(raw.side as FeeSide)) {
      errors.push({ field: at('side'), message: `must be one of ${FEE_SIDES.join(', ')}` });
    }
    if (
      typeof raw.percent !== 'number' ||
      !Number.isFinite(raw.percent) ||
      raw.percent < 0 ||
      raw.percent > 100
    ) {
      errors.push({ field: at('percent'), message: 'must be a number from 0 to 100' });
    } else if (decimalsOf(raw.percent) > 3) {
      errors.push({ field: at('percent'), message: 'must have at most three decimals' });
    }
    const hasMin = raw.min_minor !== undefined && raw.min_minor !== null;
    if (hasMin && (!Number.isInteger(raw.min_minor) || (raw.min_minor as number) < 0)) {
      errors.push({
        field: at('min_minor'),
        message: 'must be a whole number of minor units, 0 or more',
      });
    }
    if (hasMin && (typeof raw.min_currency !== 'string' || !CURRENCY.test(raw.min_currency))) {
      errors.push({
        field: at('min_currency'),
        message: 'must be a three-letter ISO currency code when min_minor is set',
      });
    }
    if (typeof raw.source_url !== 'string' || !/^https?:\/\/\S+$/.test(raw.source_url)) {
      errors.push({ field: at('source_url'), message: 'must be the URL of the official fee page' });
    }
    if (
      typeof raw.read_on !== 'string' ||
      !DAY.test(raw.read_on) ||
      Number.isNaN(Date.parse(`${raw.read_on}T00:00:00Z`))
    ) {
      errors.push({
        field: at('read_on'),
        message: 'must be the day the fee page was read, as YYYY-MM-DD',
      });
    }
    if (errors.length > before) return;

    const key = `${String(raw.platform)}/${String(raw.project_type)}/${String(raw.side)}`;
    if (seen.has(key)) {
      errors.push({ field: `[${String(index)}]`, message: `repeats the rule for ${key}` });
      return;
    }
    seen.add(key);
    rules.push({
      platform: raw.platform as Platform,
      projectType: raw.project_type as ProjectType,
      side: raw.side as FeeSide,
      percent: raw.percent as number,
      minMinor: hasMin ? (raw.min_minor as number) : null,
      minCurrency: hasMin ? (raw.min_currency as string) : null,
      sourceUrl: raw.source_url as string,
      readOn: raw.read_on as string,
    });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rules };
}

export function findFeeRule(
  rules: readonly FeeRule[],
  platform: Platform,
  projectType: ProjectType,
  side: FeeSide,
): FeeRule | null {
  return (
    rules.find(
      (r) => r.platform === platform && r.projectType === projectType && r.side === side,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------------------
// Money arithmetic: whole minor units, BigInt, round half up.

/** Integer division rounded half away from zero, so a half-cent never disappears. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('divRoundHalfUp needs a positive denominator');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

/** A decimal string as an integer scaled by 10^scale, parsed exactly: "18.25" at scale 8 is 1825000000n. */
export function parseDecimal(text: string, scale: number): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a decimal number`);
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > scale) {
    throw new Error(`"${text}" has more than ${String(scale)} decimals`);
  }
  const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign ? -scaled : scaled;
}

/** `percent` of an amount, where percent has at most three decimals: 10 for 10%, 2.5 for 2.5%. */
export function percentOf(amountMinor: number, percent: number): number {
  if (!Number.isInteger(amountMinor)) throw new Error('amounts are whole minor units');
  const milli = parseDecimal(percent.toString(), 3);
  return Number(divRoundHalfUp(BigInt(amountMinor) * milli, 100_000n));
}

/**
 * A platform's fee on an amount under one fee rule: the rule's percentage, or its minimum
 * when that is more. `minimumMinor` is the rule's minimum already in the amount's currency
 * (the caller converts it at a stored rate), or null when the rule has none. The margin
 * engine applies the same rule to the client's price (the freelancer side); the reprice
 * worker applies it to a bid on our own project (the employer side, ARB-204).
 */
export function feeOn(
  amountMinor: number,
  rule: Pick<FeeRule, 'percent'>,
  minimumMinor: number | null,
): { readonly feeMinor: number; readonly minimumApplied: boolean } {
  const byPercent = percentOf(amountMinor, rule.percent);
  const minimumApplied = minimumMinor !== null && minimumMinor > byPercent;
  return { feeMinor: minimumApplied ? minimumMinor : byPercent, minimumApplied };
}

/** How many decimals an FX rate carries: `margin_evaluations.fx_rate_used` is numeric(18, 8). */
export const FX_RATE_SCALE = 8;

export interface FxQuote {
  /** Units of `to` per one unit of `from`, as a decimal string with at most eight decimals. */
  readonly rate: string;
  readonly from: string;
  readonly to: string;
  /** When the rate was observed, ISO 8601 (05 section 3.4). */
  readonly at: string;
  /** Who said so: the provider's name (docs/02 B-10). */
  readonly source: string;
}

/** An amount in `quote.from` minor units, in `quote.to` minor units. */
export function convertMinor(amountMinor: number, quote: FxQuote): number {
  if (!Number.isInteger(amountMinor)) throw new Error('amounts are whole minor units');
  const rate = parseDecimal(quote.rate, FX_RATE_SCALE);
  if (rate <= 0n) throw new Error(`an FX rate must be positive, got ${quote.rate}`);
  return Number(divRoundHalfUp(BigInt(amountMinor) * rate, 10n ** BigInt(FX_RATE_SCALE)));
}

/** `part` as a percentage of `whole` with three decimals, e.g. "42.556". */
export function percentageOf(partMinor: number, wholeMinor: number): string {
  if (wholeMinor <= 0) return '0.000';
  const milli = divRoundHalfUp(BigInt(partMinor) * 100_000n, BigInt(wholeMinor));
  const negative = milli < 0n;
  const digits = (negative ? -milli : milli).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

function money(minor: number, currency: string): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(3, '0');
  return `${negative ? '-' : ''}${currency} ${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------------------
// The evaluation

export interface MarginInputs {
  /** The deal currency: the job's, and the estimate's. */
  readonly currency: string;
  /** Per hour when true; the budget and the supplier cost are then both per hour. */
  readonly hourly: boolean;
  readonly clientBudgetMinor: number;
  readonly supplierCostMinor: number;
  readonly toolCostMinor: number;
  readonly fee: FeeRule;
  /** The fee rule's minimum in the deal currency, converted by the caller when it had to be. */
  readonly feeMinimumMinor: number | null;
  /** docs/02 D-03. Applied to the budget when the deal is not in the home currency. */
  readonly fxBufferPercent: number;
  /** docs/02 D-02. */
  readonly minMarginPercent: number;
  readonly minMarginHomeMinor: number;
  /** Deal currency to home currency. Required when they differ. */
  readonly fxToHome: FxQuote | null;
}

export interface MarginEvaluation {
  readonly currency: string;
  readonly clientBudgetMinor: number;
  readonly platformFeeMinor: number;
  /** True when the platform's minimum fee was more than its percentage. */
  readonly feeMinimumApplied: boolean;
  readonly supplierCostMinor: number;
  readonly fxBufferMinor: number;
  readonly toolCostMinor: number;
  readonly marginMinor: number;
  /** Three decimals, e.g. "42.556". */
  readonly marginPercent: string;
  /** The margin in the home currency, or null for a per-hour evaluation with no rate needed. */
  readonly marginHomeMinor: number | null;
  readonly minMarginPercent: number;
  readonly minMarginHomeMinor: number;
  /** Whether the ZAR minimum was judged. It is a per-job amount, so it is not applied per hour. */
  readonly absoluteRuleApplied: boolean;
  readonly passed: boolean;
  readonly reason: string;
  /**
   * The lowest price in the deal currency at which this deal clears both rules, or null
   * when no price can (the percentages leave nothing). What the draft-bid worker prices
   * from (ARB-043: "price equals margin output").
   */
  readonly requiredPriceMinor: number | null;
}

interface Lines {
  fee: number;
  feeMinimumApplied: boolean;
  buffer: number;
  margin: number;
  requiredByPercent: number;
  marginHome: number | null;
}

function linesAt(price: number, inputs: MarginInputs, abroad: boolean): Lines {
  const { feeMinor: fee, minimumApplied: feeMinimumApplied } = feeOn(
    price,
    inputs.fee,
    inputs.feeMinimumMinor,
  );
  const buffer = abroad ? percentOf(price, inputs.fxBufferPercent) : 0;
  const margin = price - fee - inputs.supplierCostMinor - buffer - inputs.toolCostMinor;
  const marginHome = abroad ? convertMinor(margin, inputs.fxToHome!) : margin;
  return {
    fee,
    feeMinimumApplied,
    buffer,
    margin,
    requiredByPercent: percentOf(price, inputs.minMarginPercent),
    marginHome,
  };
}

function clears(lines: Lines, inputs: MarginInputs): boolean {
  if (lines.margin < lines.requiredByPercent) return false;
  if (inputs.hourly) return true;
  return lines.marginHome !== null && lines.marginHome >= inputs.minMarginHomeMinor;
}

/**
 * The lowest whole price that clears both rules. The gap between margin and requirement
 * grows with the price only while the percentages leave something (100 − fee − buffer −
 * minimum > 0); when they do not, no price clears and the answer is null.
 */
function requiredPrice(inputs: MarginInputs, abroad: boolean): number | null {
  const slope =
    100 - inputs.fee.percent - (abroad ? inputs.fxBufferPercent : 0) - inputs.minMarginPercent;
  if (slope <= 0) return null;
  const fixedCosts =
    inputs.supplierCostMinor + inputs.toolCostMinor + (inputs.feeMinimumMinor ?? 0);
  // Generous ceiling: every cost plus the ZAR minimum, scaled up by the slope.
  let high = Math.ceil(((fixedCosts + inputs.minMarginHomeMinor * 10) * 100) / slope) + 1;
  if (!clears(linesAt(high, inputs, abroad), inputs)) {
    high *= 100;
    if (!clears(linesAt(high, inputs, abroad), inputs)) return null;
  }
  let low = 0;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (clears(linesAt(mid, inputs, abroad), inputs)) high = mid;
    else low = mid + 1;
  }
  return high;
}

export function evaluateMargin(inputs: MarginInputs): MarginEvaluation {
  const abroad = inputs.currency !== HOME_CURRENCY;
  if (abroad && !inputs.fxToHome) {
    throw new Error(`a ${inputs.currency} deal needs a rate to ${HOME_CURRENCY} to be judged`);
  }
  if (
    inputs.fxToHome &&
    (inputs.fxToHome.from !== inputs.currency || inputs.fxToHome.to !== HOME_CURRENCY)
  ) {
    throw new Error(
      `the rate is ${inputs.fxToHome.from}→${inputs.fxToHome.to}, not ${inputs.currency}→${HOME_CURRENCY}`,
    );
  }
  for (const [name, value] of Object.entries({
    clientBudgetMinor: inputs.clientBudgetMinor,
    supplierCostMinor: inputs.supplierCostMinor,
    toolCostMinor: inputs.toolCostMinor,
    minMarginHomeMinor: inputs.minMarginHomeMinor,
  })) {
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} must be whole minor units, 0 or more`);
  }

  const lines = linesAt(inputs.clientBudgetMinor, inputs, abroad);
  const percentOk = lines.margin >= lines.requiredByPercent;
  const absoluteOk =
    inputs.hourly || (lines.marginHome !== null && lines.marginHome >= inputs.minMarginHomeMinor);
  const passed = percentOk && absoluteOk;
  const marginPercent = percentageOf(lines.margin, inputs.clientBudgetMinor);

  const problems: string[] = [];
  if (!percentOk) {
    problems.push(
      `margin ${marginPercent}% is below the ${percentageOf(inputs.minMarginPercent * 1000, 100_000)}% minimum`,
    );
  }
  if (!absoluteOk && lines.marginHome !== null) {
    problems.push(
      `margin ${money(lines.marginHome, HOME_CURRENCY)} is below the ${money(inputs.minMarginHomeMinor, HOME_CURRENCY)} minimum`,
    );
  }
  const unit = inputs.hourly ? ' per hour' : '';
  const reason = passed
    ? `margin ${money(lines.margin, inputs.currency)}${unit} (${marginPercent}%) clears the rules` +
      (inputs.hourly ? '; the ZAR minimum is per job and is not applied per hour' : '')
    : problems.join('; ');

  return {
    currency: inputs.currency,
    clientBudgetMinor: inputs.clientBudgetMinor,
    platformFeeMinor: lines.fee,
    feeMinimumApplied: lines.feeMinimumApplied,
    supplierCostMinor: inputs.supplierCostMinor,
    fxBufferMinor: lines.buffer,
    toolCostMinor: inputs.toolCostMinor,
    marginMinor: lines.margin,
    marginPercent,
    marginHomeMinor: inputs.hourly ? null : lines.marginHome,
    minMarginPercent: inputs.minMarginPercent,
    minMarginHomeMinor: inputs.minMarginHomeMinor,
    absoluteRuleApplied: !inputs.hourly,
    passed,
    reason,
    requiredPriceMinor: requiredPrice(inputs, abroad),
  };
}
