import { describe, expect, it } from 'vitest';
import { readTermsOnShow } from './terms.js';

/** ARB-522: the API reads the terms the web app shows, and makes no org while they are pending. */
describe('readTermsOnShow', () => {
  it('reads the committed file, which is pending until the owner publishes the terms (D-16)', () => {
    expect(readTermsOnShow()).toEqual({ status: 'pending' });
  });

  it('gives the version and approval date of approved terms', () => {
    const approved = {
      status: 'approved',
      approvedBy: 'Approver name',
      approvedOn: '2026-10-01',
      version: 'v1',
      sections: [{ heading: 'Heading', paragraphs: ['Paragraph.'] }],
    };
    expect(readTermsOnShow(() => JSON.stringify(approved))).toEqual({
      status: 'approved',
      terms: { version: 'v1', approvedOn: '2026-10-01' },
    });
  });

  it('says why a broken file cannot be used, and treats it as not published', () => {
    const broken = readTermsOnShow(() => '{ not json');
    expect(broken.status).toBe('unreadable');
    const invalid = readTermsOnShow(() => JSON.stringify({ status: 'approved', version: 'v1' }));
    expect(invalid).toMatchObject({ status: 'unreadable' });
    if (invalid.status === 'unreadable') expect(invalid.reason).toMatch(/approvedBy/);
  });
});
