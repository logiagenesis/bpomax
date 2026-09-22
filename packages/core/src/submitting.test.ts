import { describe, expect, it } from 'vitest';
import { autoSendMetric, bidPayload, capDay, checkApproval, liveGate } from './submitting.js';

/** ARB-044: what may leave the building, decided without a database or a platform. */

describe('liveGate', () => {
  it('opens only when the environment and the organisation both say live', () => {
    expect(liveGate({ envLiveMode: true, orgLiveMode: true })).toEqual({ live: true });
  });

  it('closes on either switch, and says which', () => {
    const env = liveGate({ envLiveMode: false, orgLiveMode: true });
    expect(env).toMatchObject({ live: false, closedBy: 'environment' });
    if (!env.live) expect(env.message).toMatch(/LIVE_MODE is false in this environment/);
    const org = liveGate({ envLiveMode: true, orgLiveMode: false });
    expect(org).toMatchObject({ live: false, closedBy: 'org' });
    const both = liveGate({ envLiveMode: false, orgLiveMode: false });
    expect(both).toMatchObject({ live: false, closedBy: 'both' });
    if (!both.live) expect(both.message).toMatch(/would have been sent is in the audit log/);
  });
});

describe('checkApproval', () => {
  it('passes only an approved proposal with a named approver and channel', () => {
    expect(checkApproval({ status: 'approved', approvedBy: 'u', approvedVia: 'web' })).toEqual({
      ok: true,
      via: 'web',
    });
    expect(checkApproval({ status: 'queued', approvedBy: null, approvedVia: null })).toEqual({
      ok: false,
      reason: 'not_approved',
    });
    expect(checkApproval({ status: 'rejected', approvedBy: 'u', approvedVia: 'web' })).toEqual({
      ok: false,
      reason: 'not_approved',
    });
    expect(checkApproval({ status: 'submitted', approvedBy: 'u', approvedVia: 'web' })).toEqual({
      ok: false,
      reason: 'already_submitted',
    });
    expect(checkApproval({ status: 'approved', approvedBy: null, approvedVia: 'web' })).toEqual({
      ok: false,
      reason: 'approval_incomplete',
    });
    expect(checkApproval({ status: 'approved', approvedBy: 'u', approvedVia: null })).toEqual({
      ok: false,
      reason: 'approval_incomplete',
    });
  });
});

describe('the daily cap s day and counter', () => {
  it('is the South African calendar day', () => {
    expect(capDay(new Date('2026-09-22T12:00:00Z'))).toBe('2026-09-22');
    // 22:30 UTC is 00:30 the next day in Johannesburg.
    expect(capDay(new Date('2026-09-22T22:30:00Z'))).toBe('2026-09-23');
    expect(autoSendMetric('abc')).toBe('auto_send:abc');
  });
});

describe('bidPayload', () => {
  const fields = {
    platform: 'freelancer',
    jobExternalId: '12345',
    proposalId: 'p',
    amountMinor: 450_000,
    currency: 'ZAR',
    deliveryDays: 7,
    milestones: [
      { title: 'Design', amount_minor: 150_000 },
      { title: 'Build', amount_minor: 300_000 },
    ],
    body: 'Thanks for the brief.',
  };

  it('is the fields that would be sent, with no endpoint of its own', () => {
    const payload = bidPayload(fields);
    expect(payload).toEqual({ action: 'place_bid', ...fields });
    expect(JSON.stringify(payload)).not.toMatch(/https?:|\/api\//);
  });

  it('refuses milestones that do not sum to the bid (05 section 3.5)', () => {
    expect(() =>
      bidPayload({ ...fields, milestones: [{ title: 'All', amount_minor: 449_999 }] }),
    ).toThrow(/sum to 449999 but the bid is 450000/);
    expect(bidPayload({ ...fields, milestones: [] }).milestones).toEqual([]);
  });
});
