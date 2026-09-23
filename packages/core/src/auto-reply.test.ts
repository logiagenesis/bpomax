import { describe, expect, it } from 'vitest';
import { operatorIsOffline, validateAutoReply } from './auto-reply.js';

describe('validateAutoReply', () => {
  it('accepts the wording, the switch and the minutes, trimming the text', () => {
    expect(
      validateAutoReply({
        body: '  Thanks, back soon.  ',
        active: true,
        offlineAfterMinutes: '45',
      }),
    ).toEqual({
      ok: true,
      value: { body: 'Thanks, back soon.', active: true, offlineAfterMinutes: 45 },
    });
    expect(validateAutoReply({ body: '', active: false })).toEqual({
      ok: true,
      value: { body: '', active: false, offlineAfterMinutes: 30 },
    });
  });

  it('refuses an empty wording while on, over-long text and minutes out of range', () => {
    const on = validateAutoReply({ body: ' ', active: 'on', offlineAfterMinutes: 30 });
    expect(on).toMatchObject({ ok: false });
    expect(!on.ok && on.errors).toEqual([
      { field: 'body', message: 'must not be empty while the auto-reply is on' },
    ]);
    const long = validateAutoReply({ body: 'x'.repeat(2001), active: false });
    expect(!long.ok && long.errors[0]?.field).toBe('body');
    const minutes = validateAutoReply({ body: 'ok', active: true, offlineAfterMinutes: 0 });
    expect(!minutes.ok && minutes.errors[0]?.message).toBe('must be between 1 and 1440 minutes');
    const text = validateAutoReply({ body: 'ok', active: true, offlineAfterMinutes: 'soon' });
    expect(!text.ok && text.errors[0]?.message).toBe('must be a whole number of minutes');
    expect(validateAutoReply(null)).toMatchObject({ ok: false });
    expect(validateAutoReply({ body: 1 })).toMatchObject({ ok: false });
  });
});

describe('operatorIsOffline', () => {
  const now = new Date('2026-09-23T10:00:00Z');
  it('is offline with no message ever, or none for the period; online within it', () => {
    expect(operatorIsOffline({ lastOutboundAt: null, now, offlineAfterMinutes: 30 })).toBe(true);
    // Hand-worked: 30 minutes before 10:00 is 09:30; a message at 09:30 exactly is offline.
    expect(
      operatorIsOffline({
        lastOutboundAt: new Date('2026-09-23T09:30:00Z'),
        now,
        offlineAfterMinutes: 30,
      }),
    ).toBe(true);
    expect(
      operatorIsOffline({
        lastOutboundAt: new Date('2026-09-23T09:30:01Z'),
        now,
        offlineAfterMinutes: 30,
      }),
    ).toBe(false);
  });
});
