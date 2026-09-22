/**
 * Model prices (ARB-031, docs/01 section C).
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing — read 22/09/2026.
 * Nothing here is from memory. When a price changes, change it here and change the
 * `PRICES_READ_ON` date with it; `pricing.test.ts` refuses a table that is internally
 * inconsistent, and the date is what tells a reviewer how stale the figures are.
 *
 * Prices are held as whole **nano-US-dollars per token** rather than dollars per million
 * tokens, so every figure on the published table is an exact integer here and a cost is
 * never a rounded float. $5/MTok is 5000 nano per token; $0.25/MTok is 250.
 */
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICES_READ_ON = '2026-09-22';

export interface ModelPrice {
  /** Standard input tokens. */
  readonly inputNanoPerToken: number;
  readonly outputNanoPerToken: number;
  /** Writing to a 5-minute cache. */
  readonly cacheWrite5mNanoPerToken: number;
  /** Writing to a 1-hour cache. */
  readonly cacheWrite1hNanoPerToken: number;
  /** Reading from cache, and refreshes. */
  readonly cacheReadNanoPerToken: number;
}

/**
 * Only the models this application may be configured to use. An unknown model is an
 * error rather than a zero, because a zero cost is a silent lie on every report that
 * reads it.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // $10 / $50 per MTok, cache read $0.25
  'claude-fable-5-1': {
    inputNanoPerToken: 10_000,
    outputNanoPerToken: 50_000,
    cacheWrite5mNanoPerToken: 12_500,
    cacheWrite1hNanoPerToken: 20_000,
    cacheReadNanoPerToken: 250,
  },
  // $5 / $25 per MTok, cache read $0.50
  'claude-opus-5': {
    inputNanoPerToken: 5_000,
    outputNanoPerToken: 25_000,
    cacheWrite5mNanoPerToken: 6_250,
    cacheWrite1hNanoPerToken: 10_000,
    cacheReadNanoPerToken: 500,
  },
  // $2 / $10 per MTok, cache read $0.20
  'claude-sonnet-5': {
    inputNanoPerToken: 2_000,
    outputNanoPerToken: 10_000,
    cacheWrite5mNanoPerToken: 2_500,
    cacheWrite1hNanoPerToken: 4_000,
    cacheReadNanoPerToken: 200,
  },
  // $1 / $5 per MTok, cache read $0.10
  'claude-haiku-4-5-20251001': {
    inputNanoPerToken: 1_000,
    outputNanoPerToken: 5_000,
    cacheWrite5mNanoPerToken: 1_250,
    cacheWrite1hNanoPerToken: 2_000,
    cacheReadNanoPerToken: 100,
  },
};

export function isPricedModel(model: string): boolean {
  return Object.hasOwn(MODEL_PRICES, model);
}

export function priceFor(model: string): ModelPrice {
  const price = MODEL_PRICES[model];
  if (!price) {
    throw new Error(
      `no price for model "${model}". Add it to MODEL_PRICES from ${PRICES_SOURCE} before using it; ` +
        `a model with no price would be metered at zero.`,
    );
  }
  return price;
}
