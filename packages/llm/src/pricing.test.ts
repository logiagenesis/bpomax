import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, PRICES_READ_ON, PRICES_SOURCE, isPricedModel, priceFor } from './pricing.js';

/**
 * ARB-031: the price table is transcribed from a published page, so what is worth
 * testing is that it was transcribed correctly. The cache multipliers are stated on that
 * page, which makes them a check a typo cannot survive.
 */
describe('the price table', () => {
  it('says where it came from and when', () => {
    expect(PRICES_SOURCE).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
    expect(PRICES_READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(PRICES_READ_ON))).toBe(false);
  });

  it.each(Object.keys(MODEL_PRICES))('prices %s in whole nano-dollars', (model) => {
    const price = priceFor(model);
    for (const [field, value] of Object.entries(price)) {
      expect(Number.isInteger(value), `${model}.${field}`).toBe(true);
      expect(value, `${model}.${field}`).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(MODEL_PRICES))('applies the published cache multipliers to %s', (model) => {
    const price = priceFor(model);
    // Published: 5-minute cache write is 1.25x base input, 1-hour is 2x.
    expect(price.cacheWrite5mNanoPerToken).toBe(price.inputNanoPerToken * 1.25);
    expect(price.cacheWrite1hNanoPerToken).toBe(price.inputNanoPerToken * 2);

    // Published: cache reads are 0.1x base input, except 0.025x on Fable 5.1.
    const readMultiplier = model === 'claude-fable-5-1' ? 0.025 : 0.1;
    expect(price.cacheReadNanoPerToken).toBe(price.inputNanoPerToken * readMultiplier);
  });

  it('holds the headline figures the page publishes', () => {
    // $5 in / $25 out per million tokens.
    expect(priceFor('claude-opus-5').inputNanoPerToken * 1_000_000).toBe(5 * 1e9);
    expect(priceFor('claude-opus-5').outputNanoPerToken * 1_000_000).toBe(25 * 1e9);
    // $2 / $10.
    expect(priceFor('claude-sonnet-5').inputNanoPerToken * 1_000_000).toBe(2 * 1e9);
    expect(priceFor('claude-sonnet-5').outputNanoPerToken * 1_000_000).toBe(10 * 1e9);
    // $1 / $5.
    expect(priceFor('claude-haiku-4-5-20251001').inputNanoPerToken * 1_000_000).toBe(1e9);
    expect(priceFor('claude-haiku-4-5-20251001').outputNanoPerToken * 1_000_000).toBe(5 * 1e9);
  });

  it('refuses a model it has no price for, rather than metering it at zero', () => {
    expect(isPricedModel('claude-invented-9')).toBe(false);
    expect(() => priceFor('claude-invented-9')).toThrow(/no price for model/i);
    expect(() => priceFor('claude-invented-9')).toThrow(/metered at zero/i);
  });

  it('covers the models the environment template names by default', () => {
    // .env.example ships LLM_MODEL_SCORE and LLM_MODEL_DRAFT as claude-opus-5 (D-007).
    expect(isPricedModel('claude-opus-5')).toBe(true);
  });
});
