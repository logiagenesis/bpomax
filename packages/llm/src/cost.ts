import { priceFor } from './pricing.js';

/**
 * What one call cost (ARB-031).
 *
 * Kept in whole nano-US-dollars. A scoring call costs a fraction of a cent, so metering
 * in cents would round nearly every call to zero and every total would be wrong in the
 * same direction.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWrite5mTokens?: number;
  readonly cacheWrite1hTokens?: number;
}

export const NANO_PER_USD = 1_000_000_000;

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Adds the usage of a retried attempt to the usage already spent. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWrite5mTokens: (a.cacheWrite5mTokens ?? 0) + (b.cacheWrite5mTokens ?? 0),
    cacheWrite1hTokens: (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0),
  };
}

export interface CostOptions {
  /** The Batch API is half price on input and output alike. */
  readonly batch?: boolean;
}

export function costNanoUsd(model: string, usage: TokenUsage, options: CostOptions = {}): number {
  const price = priceFor(model);
  const total =
    usage.inputTokens * price.inputNanoPerToken +
    usage.outputTokens * price.outputNanoPerToken +
    (usage.cacheReadTokens ?? 0) * price.cacheReadNanoPerToken +
    (usage.cacheWrite5mTokens ?? 0) * price.cacheWrite5mNanoPerToken +
    (usage.cacheWrite1hTokens ?? 0) * price.cacheWrite1hNanoPerToken;

  // Every published price is a whole number of nano-dollars per token and the batch
  // discount halves figures that are all even, so this stays exact integer arithmetic.
  return options.batch ? total / 2 : total;
}

/** For display only. Never round-trip a cost through this. */
export function formatUsd(nano: number): string {
  return `$${(nano / NANO_PER_USD).toFixed(6)}`;
}
