import { describe, expect, it } from 'vitest';
import {
  MAX_TEMPLATE_NAME,
  MAX_VARIANT_BODY,
  templateFigures,
  validateTemplateChange,
  validateVariantChange,
  variantFigures,
  variantWordsLocked,
} from './templates.js';

describe('validateTemplateChange', () => {
  it('needs a name for a new template; a blank category or description means none', () => {
    expect(validateTemplateChange({}, { partial: false })).toEqual({
      ok: false,
      errors: [{ field: 'name', message: 'is required' }],
    });
    expect(
      validateTemplateChange(
        { name: '  Web rebuild ', categorySlug: '', description: ' ' },
        { partial: false },
      ),
    ).toEqual({
      ok: true,
      value: { name: 'Web rebuild', categorySlug: null, description: null },
    });
  });

  it('refuses each bad field by name, and an empty change', () => {
    expect(
      validateTemplateChange(
        { name: 'x'.repeat(MAX_TEMPLATE_NAME + 1), categorySlug: 7, active: 'yes' },
        { partial: true },
      ),
    ).toEqual({
      ok: false,
      errors: [
        { field: 'name', message: `must be ${String(MAX_TEMPLATE_NAME)} characters or fewer` },
        { field: 'categorySlug', message: 'must be text' },
        { field: 'active', message: 'must be true or false' },
      ],
    });
    expect(validateTemplateChange({}, { partial: true })).toMatchObject({ ok: false });
    expect(validateTemplateChange({ active: false }, { partial: true })).toEqual({
      ok: true,
      value: { active: false },
    });
    expect(validateTemplateChange([], { partial: true })).toMatchObject({ ok: false });
  });
});

describe('validateVariantChange', () => {
  it('needs a label and words for a new variant', () => {
    expect(validateVariantChange({ label: 'B' }, { partial: false })).toEqual({
      ok: false,
      errors: [{ field: 'body', message: 'is required' }],
    });
    expect(
      validateVariantChange({ label: ' B ', body: ' Shorter opening. ' }, { partial: false }),
    ).toEqual({ ok: true, value: { label: 'B', body: 'Shorter opening.' } });
    expect(
      validateVariantChange({ body: 'x'.repeat(MAX_VARIANT_BODY + 1) }, { partial: true }),
    ).toMatchObject({ ok: false, errors: [{ field: 'body' }] });
    expect(validateVariantChange({ active: true }, { partial: true })).toEqual({
      ok: true,
      value: { active: true },
    });
  });
});

describe('the figures', () => {
  it('reply rate is replies of sends, to one decimal half up, and no data with none sent', () => {
    // 2 of 3 = 66,666… % → 66,7 %; 1 of 8 = 12,5 %; 0 of 0 is no data, not 0 %.
    expect(variantFigures(3, 2)).toEqual({
      sends: 3,
      replies: 2,
      replyRate: { numerator: 2, denominator: 3, percent: '66.7' },
    });
    expect(variantFigures(8, 1).replyRate.percent).toBe('12.5');
    expect(variantFigures(0, 0).replyRate).toEqual({ numerator: 0, denominator: 0, percent: null });
  });

  it('a template adds its variants up before dividing', () => {
    // (2 + 1) of (3 + 8) = 3 of 11 = 27,27… % → 27,3 %, not the mean of 66,7 and 12,5.
    expect(templateFigures([variantFigures(3, 2), variantFigures(8, 1)])).toEqual({
      sends: 11,
      replies: 3,
      replyRate: { numerator: 3, denominator: 11, percent: '27.3' },
    });
    expect(templateFigures([]).replyRate.percent).toBeNull();
  });

  it('locks a variant’s words once one bid from it has gone', () => {
    expect(variantWordsLocked(0)).toBeNull();
    expect(variantWordsLocked(1)).toMatch(/^This variant has been sent 1 time, /);
    expect(variantWordsLocked(4)).toMatch(/sent 4 times/);
  });
});
