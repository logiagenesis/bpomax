import { describe, expect, it } from 'vitest';
import {
  liveModeBlockers,
  validateMarginRules,
  validatePlanRecord,
  validateProposalEdit,
  validateRejection,
} from './settings.js';

const FEE_RULE = {
  platform: 'freelancer',
  project_type: 'fixed',
  side: 'freelancer',
  percent: 10,
  min_minor: 500,
  min_currency: 'USD',
  source_url: 'https://www.freelancer.com/feesandcharges',
  read_on: '2026-09-22',
};

describe('validateMarginRules', () => {
  it('accepts a full set of rules', () => {
    const result = validateMarginRules({
      minMarginPct: 25,
      minMarginZarMinor: 150000,
      fxBufferPct: 3.5,
      vatPct: 15,
      retentionDays: 365,
      feeTable: [FEE_RULE],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.minMarginPct).toBe(25);
    expect(result.value.minMarginZarMinor).toBe(150000);
    expect(result.value.fxBufferPct).toBe(3.5);
    expect(result.value.vatPct).toBe(15);
    expect(result.value.retentionDays).toBe(365);
    expect(result.value.feeTable?.[0]?.percent).toBe(10);
  });

  it('accepts one field at a time and reads numeric strings as a form sends them', () => {
    const result = validateMarginRules({ minMarginPct: '12.5' });
    expect(result).toEqual({ ok: true, value: { minMarginPct: 12.5 } });
  });

  it('clears a nullable rule on null or an empty string, never VAT', () => {
    expect(validateMarginRules({ fxBufferPct: '' })).toEqual({
      ok: true,
      value: { fxBufferPct: null },
    });
    expect(validateMarginRules({ retentionDays: null })).toEqual({
      ok: true,
      value: { retentionDays: null },
    });
    const vat = validateMarginRules({ vatPct: '' });
    expect(vat.ok).toBe(false);
    if (!vat.ok) expect(vat.errors).toEqual([{ field: 'vatPct', message: 'is required' }]);
  });

  it('refuses negatives, too many decimals, fractions of a cent and a zero retention', () => {
    const result = validateMarginRules({
      minMarginPct: -1,
      fxBufferPct: 1.2345,
      minMarginZarMinor: 10.5,
      retentionDays: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field).sort()).toEqual([
      'fxBufferPct',
      'minMarginPct',
      'minMarginZarMinor',
      'retentionDays',
    ]);
  });

  it('refuses a fee rule without its source, naming the row', () => {
    const { source_url: _dropped, ...noSource } = FEE_RULE;
    const result = validateMarginRules({ feeTable: [noSource] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.field).toBe('feeTable[0].source_url');
  });

  it('refuses an empty change and a non-object', () => {
    expect(validateMarginRules({})).toEqual({
      ok: false,
      errors: [{ field: '', message: 'no fields to change' }],
    });
    expect(validateMarginRules('x').ok).toBe(false);
  });
});

describe('liveModeBlockers', () => {
  it('lists every missing rule with the blocker that answers it', () => {
    expect(
      liveModeBlockers({
        minMarginPct: null,
        minMarginZarMinor: null,
        fxBufferPct: null,
        feeTableLength: 0,
        retentionDays: null,
      }),
    ).toEqual([
      'minimum margin % (docs/02 D-02)',
      'minimum margin in rand (docs/02 D-02)',
      'FX buffer % (docs/02 D-03)',
      'at least one fee rule (docs/02 T-02)',
      'the retention period (docs/02 T-06)',
    ]);
  });

  it('is empty once everything is set, and zero counts as set', () => {
    expect(
      liveModeBlockers({
        minMarginPct: '0.000',
        minMarginZarMinor: '0',
        fxBufferPct: 0,
        feeTableLength: 1,
        retentionDays: 30,
      }),
    ).toEqual([]);
  });
});

describe('validatePlanRecord', () => {
  it('trims the plan name and takes a whole allowance', () => {
    expect(validatePlanRecord({ planName: '  Plus ', monthlyBidAllowance: '100' })).toEqual({
      ok: true,
      value: { planName: 'Plus', monthlyBidAllowance: 100 },
    });
  });

  it('lets both be cleared', () => {
    expect(validatePlanRecord({ planName: '', monthlyBidAllowance: '' })).toEqual({
      ok: true,
      value: { planName: null, monthlyBidAllowance: null },
    });
  });

  it('refuses a fractional or negative allowance and a blank name', () => {
    const result = validatePlanRecord({ planName: '   ', monthlyBidAllowance: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual(['planName', 'monthlyBidAllowance']);
    expect(validatePlanRecord({ monthlyBidAllowance: 1.5 }).ok).toBe(false);
  });
});

describe('proposal edits and rejections', () => {
  it('needs words', () => {
    expect(validateProposalEdit({ body: '  ' }).ok).toBe(false);
    expect(validateProposalEdit({})).toEqual({
      ok: false,
      errors: [{ field: 'body', message: 'is required' }],
    });
    expect(validateProposalEdit({ body: ' New text ' })).toEqual({
      ok: true,
      value: { text: 'New text' },
    });
  });

  it('bounds the length', () => {
    expect(validateProposalEdit({ body: 'x'.repeat(10_001) }).ok).toBe(false);
    expect(validateRejection({ reason: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateRejection({ reason: 'Budget too low' })).toEqual({
      ok: true,
      value: { text: 'Budget too low' },
    });
  });
});
