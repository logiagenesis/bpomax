import { describe, expect, it } from 'vitest';
import { outboundMessageState, validateMessageDraft } from './messaging.js';

describe('validateMessageDraft', () => {
  it('trims and accepts text, refuses empty, over-long and non-text', () => {
    expect(validateMessageDraft({ body: '  Hello  ' })).toEqual({
      ok: true,
      value: { text: 'Hello' },
    });
    expect(validateMessageDraft({ body: '   ' })).toEqual({
      ok: false,
      errors: [{ field: 'body', message: 'must not be empty' }],
    });
    expect(validateMessageDraft({ body: 'x'.repeat(4001) })).toMatchObject({ ok: false });
    expect(validateMessageDraft({ body: 4 })).toMatchObject({ ok: false });
    expect(validateMessageDraft('x')).toMatchObject({ ok: false });
  });
});

describe('outboundMessageState', () => {
  it('reads the state from the columns in order', () => {
    const none = { sentAt: null, approvedBy: null, rejectedAt: null, failureReason: null };
    expect(outboundMessageState(none)).toBe('queued');
    expect(outboundMessageState({ ...none, approvedBy: 'u' })).toBe('approved');
    expect(outboundMessageState({ ...none, approvedBy: 'u', failureReason: 'refused' })).toBe(
      'failed',
    );
    expect(outboundMessageState({ ...none, rejectedAt: '2026-09-23T10:00:00Z' })).toBe('rejected');
    expect(outboundMessageState({ ...none, approvedBy: 'u', sentAt: new Date() })).toBe('sent');
  });
});
