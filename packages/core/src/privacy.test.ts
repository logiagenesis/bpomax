import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePrivacyNotice } from './privacy.js';

/**
 * ARB-015: the published privacy notice is either pending with no wording, or approved
 * with the approval recorded. The owner's text is not written here (T-06); these cases
 * use placeholder strings that only exercise the shape.
 */
const APPROVED = {
  status: 'approved',
  approvedBy: 'Approver name',
  approvedOn: '2026-10-01',
  version: 'v1',
  sections: [{ heading: 'Heading one', paragraphs: ['Paragraph one.', 'Paragraph two.'] }],
};

describe('parsePrivacyNotice', () => {
  it('accepts the committed notice, which is pending until T-06 is answered', () => {
    const committed: unknown = JSON.parse(
      readFileSync(
        new URL('../../../apps/web/src/public/privacy-notice.json', import.meta.url),
        'utf8',
      ),
    );
    const result = parsePrivacyNotice(committed);
    expect(result.ok).toBe(true);
    // Flip this expectation when the owner publishes approved wording (docs/02 T-06).
    expect(result.ok && result.value.status).toBe('pending');
  });

  it('refuses a pending notice that carries wording, so a draft is never published', () => {
    const result = parsePrivacyNotice({ status: 'pending', sections: APPROVED.sections });
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          field: 'sections',
          message: 'must be empty while the notice is pending; no draft wording is published',
        },
      ],
    });
  });

  it('accepts approved wording with who approved it, when, and a version, trimmed', () => {
    const result = parsePrivacyNotice({
      ...APPROVED,
      approvedBy: '  Approver name ',
      sections: [{ heading: ' Heading one ', paragraphs: [' Paragraph one. '] }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: 'approved',
        approvedBy: 'Approver name',
        approvedOn: '2026-10-01',
        version: 'v1',
        sections: [{ heading: 'Heading one', paragraphs: ['Paragraph one.'] }],
      },
    });
  });

  it('refuses approved wording without its approval, field by field', () => {
    const result = parsePrivacyNotice({
      status: 'approved',
      approvedBy: ' ',
      approvedOn: '2026-02-30',
      version: '',
      sections: [
        { heading: '', paragraphs: [] },
        { heading: 'Two', paragraphs: ['ok', ''] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.field)).toEqual([
      'approvedBy',
      'approvedOn',
      'version',
      'sections[0].heading',
      'sections[0].paragraphs',
      'sections[1].paragraphs',
    ]);
  });

  it('refuses approved status with no sections, an unknown status, and a non-object', () => {
    expect(parsePrivacyNotice({ ...APPROVED, sections: [] }).ok).toBe(false);
    expect(parsePrivacyNotice({ status: 'draft' })).toEqual({
      ok: false,
      errors: [{ field: 'status', message: 'must be pending or approved' }],
    });
    expect(parsePrivacyNotice(null).ok).toBe(false);
    expect(parsePrivacyNotice([]).ok).toBe(false);
  });
});
