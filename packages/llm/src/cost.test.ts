import { describe, expect, it } from 'vitest';
import { NANO_PER_USD, addUsage, costNanoUsd, emptyUsage, formatUsd } from './cost.js';

/** ARB-031: costs are hand-checkable against the published per-million-token prices. */
describe('costing a call', () => {
  it('matches the published price for a round million tokens', () => {
    // Opus 5: $5 per million in, $25 per million out.
    const cost = costNanoUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(30 * NANO_PER_USD);
    expect(formatUsd(cost)).toBe('$30.000000');
  });

  it('is exact for the small calls scoring actually makes', () => {
    // 1,000 in and 500 out on Opus 5: $0.005 + $0.0125 = $0.0175.
    const cost = costNanoUsd('claude-opus-5', { inputTokens: 1_000, outputTokens: 500 });
    expect(cost).toBe(17_500_000);
    expect(formatUsd(cost)).toBe('$0.017500');
    // Metering this in cents would have recorded 2c, or 0c if it rounded down.
    expect(cost / NANO_PER_USD).toBeLessThan(0.02);
  });

  it('never produces a fraction of a nano-dollar', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
      for (const tokens of [1, 7, 333, 99_991]) {
        const cost = costNanoUsd(model, { inputTokens: tokens, outputTokens: tokens });
        expect(Number.isInteger(cost), `${model} @ ${String(tokens)}`).toBe(true);
      }
    }
  });

  it('charges cache reads and writes at their own rates', () => {
    const cost = costNanoUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    // $0.50 + $6.25 + $10.00
    expect(cost).toBe(16.75 * NANO_PER_USD);
  });

  it('halves everything for a batch call', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const standard = costNanoUsd('claude-opus-5', usage);
    const batch = costNanoUsd('claude-opus-5', usage, { batch: true });
    expect(batch).toBe(standard / 2);
    // Published batch price for Opus 5: $2.50 in, $12.50 out.
    expect(batch).toBe(15 * NANO_PER_USD);
  });

  it('refuses to cost a model it has no price for', () => {
    expect(() => costNanoUsd('gpt-something', { inputTokens: 1, outputTokens: 1 })).toThrow(
      /no price for model/i,
    );
  });
});

describe('adding up attempts', () => {
  it('starts at nothing', () => {
    expect(costNanoUsd('claude-opus-5', emptyUsage())).toBe(0);
  });

  it('sums every field, treating absent cache figures as zero', () => {
    const total = addUsage(
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7 },
    );
    expect(total).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 7,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });
});
