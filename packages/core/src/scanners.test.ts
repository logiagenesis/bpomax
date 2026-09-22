import { describe, expect, it } from 'vitest';
import { checkAutoSendGuardrails, validateScanner, type ValidScanner } from './scanners.js';

/** ARB-021: the pure edges the route tests do not isolate. */
function valueOf(result: ReturnType<typeof validateScanner>): Partial<ValidScanner> {
  if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

describe('a new scanner', () => {
  it('starts safe: active, not auto-sending, no cap, no floor', () => {
    const value = valueOf(validateScanner({ name: 'New' }));
    expect(value).toEqual({
      name: 'New',
      platform: 'freelancer',
      filters: {},
      pollIntervalSeconds: 120,
      active: true,
      autoSend: false,
      minScore: null,
      dailyCap: 0,
    });
  });

  it('trims the name rather than storing the spaces', () => {
    expect(valueOf(validateScanner({ name: '  Spaced  ' })).name).toBe('Spaced');
  });
});

describe('an edit', () => {
  it('leaves absent fields absent instead of resetting them to defaults', () => {
    const value = valueOf(validateScanner({ active: false }, { partial: true }));
    expect(value).toEqual({ active: false });
    expect(Object.keys(value)).not.toContain('autoSend');
  });

  it('still refuses a bad value', () => {
    const result = validateScanner({ pollIntervalSeconds: 10 }, { partial: true });
    expect(result.ok).toBe(false);
  });

  it('can clear the minimum score deliberately', () => {
    expect(valueOf(validateScanner({ minScore: null }, { partial: true })).minScore).toBeNull();
  });
});

describe('the auto-send guardrail', () => {
  it('says nothing while auto-send is off, whatever the other fields are', () => {
    expect(checkAutoSendGuardrails({ autoSend: false, dailyCap: 0, minScore: null })).toEqual([]);
  });

  it('demands both a cap and a floor', () => {
    expect(
      checkAutoSendGuardrails({ autoSend: true, dailyCap: 0, minScore: null }).map((e) => e.field),
    ).toEqual(['dailyCap', 'minScore']);
  });

  it('demands the missing one when only the other is set', () => {
    expect(
      checkAutoSendGuardrails({ autoSend: true, dailyCap: 5, minScore: null }).map((e) => e.field),
    ).toEqual(['minScore']);
    expect(
      checkAutoSendGuardrails({ autoSend: true, dailyCap: 0, minScore: 80 }).map((e) => e.field),
    ).toEqual(['dailyCap']);
  });

  it('treats a zero score floor as set, since zero is a decision', () => {
    expect(checkAutoSendGuardrails({ autoSend: true, dailyCap: 1, minScore: 0 })).toEqual([]);
  });
});
