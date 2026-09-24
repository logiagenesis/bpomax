import { describe, expect, it } from 'vitest';
import { ORG_NAME_MAX, onboardingSteps, validateNewOrg } from './orgs.js';
import { parseTermsOfService } from './terms.js';

describe('validateNewOrg (ARB-400)', () => {
  it('accepts a name, trims it, and defaults the country to ZA', () => {
    expect(validateNewOrg({ name: '  Acme Studio  ' })).toEqual({
      ok: true,
      value: { name: 'Acme Studio', countryCode: 'ZA' },
    });
  });

  it('upper-cases a two-letter country code', () => {
    expect(validateNewOrg({ name: 'Acme', countryCode: 'gb' })).toEqual({
      ok: true,
      value: { name: 'Acme', countryCode: 'GB' },
    });
  });

  it.each([
    [{}, 'name', 'is required'],
    [{ name: '   ' }, 'name', 'is required'],
    [{ name: 42 }, 'name', 'is required'],
    [{ name: 'x'.repeat(ORG_NAME_MAX + 1) }, 'name', 'must be at most 100 characters'],
    [{ name: 'Acme', countryCode: 'ZAF' }, 'countryCode', expect.stringContaining('two-letter')],
    [{ name: 'Acme', countryCode: 'Z1' }, 'countryCode', expect.stringContaining('two-letter')],
    [{ name: 'Acme', countryCode: 7 }, 'countryCode', expect.stringContaining('two-letter')],
  ])('refuses %j on %s', (input, field, message) => {
    const result = validateNewOrg(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual({ field, message });
  });

  it('accepts a name of exactly the maximum length', () => {
    expect(validateNewOrg({ name: 'x'.repeat(ORG_NAME_MAX) }).ok).toBe(true);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, 'Acme', ['Acme']]) {
      expect(validateNewOrg(body)).toEqual({
        ok: false,
        errors: [{ field: 'body', message: 'must be an object' }],
      });
    }
  });
});

describe('onboardingSteps (ARB-400)', () => {
  const nothing = {
    marginRulesSet: false,
    freelancerConnected: false,
    scannerCount: 0,
    activeTemplateCount: 0,
    telegramLinked: false,
  };

  it('lists the steps in the order they unblock each other, the org already done', () => {
    const steps = onboardingSteps(nothing);
    expect(steps.map((s) => s.key)).toEqual([
      'org',
      'margin',
      'freelancer',
      'scanner',
      'template',
      'telegram',
    ]);
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual(['org']);
    expect(steps.filter((s) => s.optional).map((s) => s.key)).toEqual(['telegram']);
  });

  it('reads each step from its own fact', () => {
    const cases = [
      ['margin', { marginRulesSet: true }],
      ['freelancer', { freelancerConnected: true }],
      ['scanner', { scannerCount: 1 }],
      ['template', { activeTemplateCount: 2 }],
      ['telegram', { telegramLinked: true }],
    ] as const;
    for (const [key, fact] of cases) {
      const done = onboardingSteps({ ...nothing, ...fact }).filter((s) => s.done);
      expect(done.map((s) => s.key)).toEqual(['org', key]);
    }
  });

  it('links each step to a page of the app', () => {
    for (const step of onboardingSteps(nothing)) {
      expect(step.href).toMatch(/^[a-z-]+\.html(#[a-z-]+)?$/);
    }
  });
});

describe('parseTermsOfService (ARB-400)', () => {
  it('holds the terms to the privacy notice rule: pending has no wording', () => {
    expect(parseTermsOfService({ status: 'pending', sections: [] })).toEqual({
      ok: true,
      value: { status: 'pending' },
    });
    expect(
      parseTermsOfService({ status: 'pending', sections: [{ heading: 'x', paragraphs: ['y'] }] })
        .ok,
    ).toBe(false);
  });

  it('shows approved terms only with who approved them and when', () => {
    const approved = {
      status: 'approved',
      approvedBy: 'The owner',
      approvedOn: '2026-10-01',
      version: '1',
      sections: [{ heading: 'Heading', paragraphs: ['Text.'] }],
    };
    expect(parseTermsOfService(approved).ok).toBe(true);
    expect(parseTermsOfService({ ...approved, approvedBy: '' }).ok).toBe(false);
  });
});
