import { describe, expect, it } from 'vitest';
import {
  PROVIDER_FOR,
  graceEnded,
  nextSubscriptionState,
  paystackSignal,
  stripeSignal,
} from './billing.js';

/** ARB-420: the rules both providers share. The grace periods here are test values. */
const NOW = new Date('2026-09-24T08:00:00Z');

describe('which provider takes which currency', () => {
  it('is rand through Paystack and US dollars through Stripe, as the ticket names them', () => {
    expect(PROVIDER_FOR).toEqual({ ZAR: 'paystack', USD: 'stripe' });
  });
});

describe('provider statuses read as ours', () => {
  it.each([
    ['active', 'paid'],
    ['trialing', 'paid'],
    ['past_due', 'payment_failed'],
    ['paused', 'payment_failed'],
    ['canceled', 'ended'],
    ['unpaid', 'ended'],
    ['incomplete_expired', 'ended'],
    ['incomplete', null],
    [null, null],
  ])('Stripe %s → %s', (status, signal) => {
    expect(stripeSignal(status)).toBe(signal);
  });

  it.each([
    ['active', 'paid'],
    ['non-renewing', 'paid'],
    ['attention', 'payment_failed'],
    ['completed', 'ended'],
    ['cancelled', 'ended'],
    ['something-new', null],
  ])('Paystack %s → %s', (status, signal) => {
    expect(paystackSignal(status)).toBe(signal);
  });
});

describe('nextSubscriptionState and the grace period', () => {
  it('a payment makes the plan active and ends any grace period', () => {
    expect(nextSubscriptionState({ status: 'past_due', graceUntil: NOW }, 'paid', NOW, 7)).toEqual({
      status: 'active',
      graceUntil: null,
    });
  });

  it('a failed payment starts the owner s grace period, once', () => {
    const failed = nextSubscriptionState(
      { status: 'active', graceUntil: null },
      'payment_failed',
      NOW,
      7,
    );
    expect(failed).toEqual({ status: 'past_due', graceUntil: new Date('2026-10-01T08:00:00Z') });
    const later = new Date('2026-09-28T08:00:00Z');
    expect(nextSubscriptionState(failed, 'payment_failed', later, 7)).toBe(failed);
  });

  it('with no grace period set, a failed payment starts no clock', () => {
    expect(nextSubscriptionState(null, 'payment_failed', NOW, null)).toEqual({
      status: 'past_due',
      graceUntil: null,
    });
  });

  it('an ended subscription is cancelled', () => {
    expect(nextSubscriptionState(null, 'ended', NOW, 7)).toEqual({
      status: 'cancelled',
      graceUntil: null,
    });
  });

  it('the grace period is over at its end, not a moment before', () => {
    const state = { status: 'past_due' as const, graceUntil: new Date('2026-10-01T08:00:00Z') };
    expect(graceEnded(state, new Date('2026-10-01T07:59:59Z'))).toBe(false);
    expect(graceEnded(state, new Date('2026-10-01T08:00:00Z'))).toBe(true);
    expect(graceEnded({ status: 'past_due', graceUntil: null }, NOW)).toBe(false);
    expect(graceEnded({ status: 'active', graceUntil: new Date(0) }, NOW)).toBe(false);
  });
});
