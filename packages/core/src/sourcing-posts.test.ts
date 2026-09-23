import { describe, expect, it } from 'vitest';
import {
  buildSourcingPost,
  clientIdentifyingProblems,
  validateSourcingPostEdit,
  type BriefScope,
} from './sourcing-posts.js';

/**
 * ARB-202 acceptance: "Drafts contain brief scope only, no client-identifying data".
 * The draft is built from the scope fields alone; the check refuses every kind of
 * identifier, one test each.
 */
const SCOPE: BriefScope = {
  outcome: 'An online shop that takes orders. It replaces a spreadsheet.',
  users: 'Customers and two staff',
  mustHaves: ['Checkout', 'Product pages'],
  later: ['Loyalty points'],
  references: ['https://acme-shop.co.za/old', 'https://example.com/nice'],
  assetsProvided: ['Logo files'],
  assetsMissing: ['Product photos'],
  techConstraints: ['Shopify', 'Next.js front end'],
  deadline: '2026-11-30',
  deadlineFixed: false,
  acceptanceCriteria: ['Orders go through'],
};

const WHO = {
  clientHandle: 'acme-shop',
  signOffName: 'Thandi Mokoena',
  jobTitle: 'Shopify store rebuild for Acme',
  jobExternalId: '15791512',
};

describe('buildSourcingPost', () => {
  it('writes the scope, and nothing else, in a fixed order', () => {
    const draft = buildSourcingPost(SCOPE, { categoryName: 'Shopify' });
    expect(draft.title).toBe('Shopify: An online shop that takes orders');
    expect(draft.body).toBe(
      [
        'An online shop that takes orders. It replaces a spreadsheet.',
        '',
        'Who uses it: Customers and two staff',
        '',
        'Must have:',
        '- Checkout',
        '- Product pages',
        '',
        'Can wait for a later phase:',
        '- Loyalty points',
        '',
        'Technology:',
        '- Shopify',
        '- Next.js front end',
        '',
        'Already available:',
        '- Logo files',
        '',
        'Still needed:',
        '- Product photos',
        '',
        'Finished when:',
        '- Orders go through',
        '',
        'Reference examples: 2, shared with the supplier chosen.',
        '',
        'Deadline: 30/11/2026 (flexible)',
        '',
        'Please quote a fixed price and a turnaround in days.',
      ].join('\n'),
    );
    // The references' links, the client's budget and the sign-off are never copied.
    expect(draft.body).not.toContain('http');
    expect(clientIdentifyingProblems(draft, WHO)).toEqual([]);
  });

  it('leaves out the sections the brief does not fill, and cuts a long title at a word', () => {
    const draft = buildSourcingPost(
      {
        ...SCOPE,
        outcome:
          'A booking system for a chain of physiotherapy practices across three provinces with online payments and reminders',
        users: null,
        later: [],
        references: [],
        deadline: null,
      },
      { categoryName: 'Web app' },
    );
    expect(draft.title.length).toBeLessThanOrEqual(120);
    expect(draft.title.endsWith('…')).toBe(true);
    expect(draft.title.startsWith('Web app: A booking system')).toBe(true);
    expect(draft.body).not.toContain('Who uses it');
    expect(draft.body).not.toContain('Can wait');
    expect(draft.body).not.toContain('Reference examples');
    expect(draft.body).not.toContain('Deadline');
  });
});

describe('clientIdentifyingProblems', () => {
  const check = (body: string) =>
    clientIdentifyingProblems({ title: 'Shopify: a shop', body }, WHO).map((e) => e.message);

  it('refuses the client’s handle, in any case', () => {
    expect(check('Built for ACME-SHOP last year')).toEqual(['contains the client’s handle']);
  });
  it('refuses the sign-off person’s name', () => {
    expect(check('Thandi Mokoena signs off')).toEqual([
      'contains the name of the client’s sign-off person',
    ]);
  });
  it('refuses the client’s public job title and job number', () => {
    expect(check('Re: shopify store rebuild for acme (job 15791512)')).toEqual([
      'repeats the client’s public job title',
      'contains the client’s job number',
    ]);
  });
  it('refuses an email address, a phone number, a link and a bare domain', () => {
    expect(check('Write to sales@example.org')).toEqual(['contains an email address']);
    expect(check('Call 012 345 6789')).toEqual(['contains a phone number']);
    expect(check('Call +27 (12) 345-6789')).toEqual(['contains a phone number']);
    expect(check('See https://example.com/brief')).toEqual(['contains a link']);
    expect(check('See www.example.com')).toEqual(['contains a link']);
    expect(check('Their site is acme.co.za')).toEqual(['contains a web address']);
  });
  it('leaves ordinary scope alone: framework names, versions, prices and dates', () => {
    expect(check('Next.js 14, Node.js 20, 5 pages, R1 500,00, due 30/11/2026, 3.5 days')).toEqual(
      [],
    );
  });
  it('checks the title as well as the body', () => {
    expect(clientIdentifyingProblems({ title: 'acme-shop rebuild', body: 'Scope' }, WHO)).toEqual([
      { field: 'title', message: 'contains the client’s handle' },
    ]);
  });
});

describe('validateSourcingPostEdit', () => {
  it('accepts text with no budget, and a budget with its currency', () => {
    expect(validateSourcingPostEdit({ title: ' T ', body: ' B ' })).toEqual({
      ok: true,
      value: { title: 'T', body: 'B', budgetMinMinor: null, budgetMaxMinor: null, currency: null },
    });
    // Hand-worked: R8 000,00 to R12 000,00 is 800 000 to 1 200 000 cents.
    expect(
      validateSourcingPostEdit({
        title: 'T',
        body: 'B',
        budgetMinMinor: 800000,
        budgetMaxMinor: 1200000,
        currency: 'zar',
      }),
    ).toMatchObject({ ok: true, value: { currency: 'ZAR', budgetMinMinor: 800000 } });
  });
  it('names every problem by field', () => {
    const result = validateSourcingPostEdit({
      title: '',
      body: 'x'.repeat(6001),
      budgetMinMinor: 5.5,
      budgetMaxMinor: 100,
      currency: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual([
      'title',
      'body',
      'budgetMinMinor',
      'currency',
    ]);
    const reversed = validateSourcingPostEdit({
      title: 'T',
      body: 'B',
      budgetMinMinor: 200,
      budgetMaxMinor: 100,
      currency: 'ZAR',
    });
    expect(reversed.ok ? [] : reversed.errors).toEqual([
      { field: 'budgetMaxMinor', message: 'must not be below the lower figure' },
    ]);
  });
});
