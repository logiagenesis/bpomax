import { describe, expect, it } from 'vitest';
import { readLlmConfig } from './config.js';

const GOOD = {
  ANTHROPIC_API_KEY: 'sk-test',
  LLM_MODEL_SCORE: 'claude-opus-5',
  LLM_MODEL_DRAFT: 'claude-opus-5',
};

/** ARB-031: configuration is checked at the edge, not discovered mid-run. */
describe('reading the LLM configuration', () => {
  it('accepts what .env.example ships', () => {
    const result = readLlmConfig(GOOD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.scoreModel).toBe('claude-opus-5');
      expect(result.config.draftModel).toBe('claude-opus-5');
    }
  });

  it('names the missing key and points at the blocker', () => {
    const result = readLlmConfig({ ...GOOD, ANTHROPIC_API_KEY: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.variable).toBe('ANTHROPIC_API_KEY');
      expect(result.problems[0]?.message).toMatch(/B-08/);
    }
  });

  it('refuses a model with no price, rather than metering it at zero later', () => {
    const result = readLlmConfig({ ...GOOD, LLM_MODEL_SCORE: 'claude-imaginary-7' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.variable).toBe('LLM_MODEL_SCORE');
      expect(result.problems[0]?.message).toMatch(/no price/i);
    }
  });

  it('reports every problem at once', () => {
    const result = readLlmConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((p) => p.variable)).toEqual([
        'ANTHROPIC_API_KEY',
        'LLM_MODEL_SCORE',
        'LLM_MODEL_DRAFT',
      ]);
    }
  });
});
