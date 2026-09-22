import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { SCORING_FIXTURES } from './scoring-fixtures.js';
import {
  HARD_FLAGS,
  RED_FLAGS,
  SCORE_SCHEMA,
  SKIP_SCORE_CEILING,
  buildScorePrompt,
  detectRedFlags,
  reconcileScore,
  type ModelScore,
} from './scoring.js';

/** ARB-032: the scoring schema and the red-flag rules, without a model. */
const validate = new Ajv({ strict: false }).compile(SCORE_SCHEMA);

const confident: ModelScore = {
  score: 85,
  verdict: 'go',
  reasons: ['Clear scope and a verified client with spend.'],
  flags: [],
  reply_probability: 0.4,
};

describe('the fixture set', () => {
  it('has twenty jobs, and every hard flag appears in at least one', () => {
    expect(SCORING_FIXTURES).toHaveLength(20);
    const flagged = new Set(SCORING_FIXTURES.flatMap((fixture) => fixture.ruleFlags));
    for (const flag of HARD_FLAGS) expect(flagged, flag).toContain(flag);
  });
});

describe('detectRedFlags', () => {
  for (const fixture of SCORING_FIXTURES) {
    it(`${fixture.key}: finds exactly ${fixture.ruleFlags.join(', ') || 'nothing'}`, () => {
      const found = detectRedFlags(fixture.job).map((finding) => finding.flag);
      expect(found.sort()).toEqual([...fixture.ruleFlags].sort());
    });
  }
});

describe('SCORE_SCHEMA', () => {
  it('accepts a well-formed score', () => {
    expect(validate(confident)).toBe(true);
  });

  it.each([
    ['a score above 100', { ...confident, score: 101 }],
    ['a fractional score', { ...confident, score: 72.5 }],
    ['an unknown verdict', { ...confident, verdict: 'maybe' }],
    ['no reasons', { ...confident, reasons: [] }],
    ['an invented flag', { ...confident, flags: ['looks_dodgy'] }],
    ['a probability above 1', { ...confident, reply_probability: 1.2 }],
    ['an extra key', { ...confident, notes: 'x' }],
    ['a missing key', { score: 50, verdict: 'go', reasons: ['ok ok'], flags: [] }],
  ])('rejects %s', (_, value) => {
    expect(validate(value)).toBe(false);
  });
});

describe('reconcileScore', () => {
  it('leaves a clean job as the model scored it', () => {
    expect(reconcileScore(confident, [])).toMatchObject({
      score: 85,
      verdict: 'go',
      flags: [],
      ruleOnlyFlags: [],
    });
  });

  it('makes any hard flag a skip, capped, even when the model said go', () => {
    const result = reconcileScore(confident, [{ flag: 'upfront_fee', why: 'asks to pay first' }]);
    expect(result.verdict).toBe('skip');
    expect(result.score).toBe(SKIP_SCORE_CEILING);
    expect(result.reply_probability).toBe(0);
    expect(result.flags).toEqual(['upfront_fee']);
    expect(result.ruleOnlyFlags).toEqual(['upfront_fee']);
    expect(result.reasons.at(-1)).toMatch(/Rule check: asks to pay first/);
  });

  it('turns go into caution for a soft flag, and leaves the score alone', () => {
    const result = reconcileScore(confident, [
      { flag: 'off_platform_contact', why: 'moves the conversation' },
    ]);
    expect(result).toMatchObject({ verdict: 'caution', score: 85 });
  });

  it('never makes a verdict better', () => {
    const skipped: ModelScore = { ...confident, score: 10, verdict: 'skip' };
    expect(reconcileScore(skipped, []).verdict).toBe('skip');
  });

  it('does not repeat a flag the model already raised', () => {
    const result = reconcileScore({ ...confident, verdict: 'caution', flags: ['vague_scope'] }, [
      { flag: 'payment_unverified', why: 'unverified' },
    ]);
    expect(result.flags).toEqual(
      ['payment_unverified', 'vague_scope'].sort(
        (a, b) => RED_FLAGS.indexOf(a as never) - RED_FLAGS.indexOf(b as never),
      ),
    );
    expect(result.ruleOnlyFlags).toEqual(['payment_unverified']);
  });
});

describe('buildScorePrompt', () => {
  it('states the budget in major units and lists every flag the schema allows', () => {
    const fixture = SCORING_FIXTURES[0]!;
    const prompt = buildScorePrompt(fixture.job);
    expect(prompt).toContain('500.00 USD to 1500.00 USD fixed');
    for (const flag of RED_FLAGS) expect(prompt).toContain(flag);
  });
});
