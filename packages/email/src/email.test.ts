import { describe, expect, it } from 'vitest';
import { createFakeEmail } from './fake.js';
import { emailConfig, isEmailAddress } from './index.js';

describe('emailConfig (B-13)', () => {
  it('sends nothing without a provider, and says why', () => {
    expect(emailConfig({})).toEqual({
      ok: false,
      reason: 'No email provider is configured (docs/02 B-13), so no email is sent.',
    });
  });

  it('does not pretend a key alone is a provider', () => {
    const result = emailConfig({ EMAIL_PROVIDER_KEY: 'a-key' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no email provider is chosen yet.*B-13/);
  });
});

describe('the stand-in', () => {
  it('keeps what it sends, and fails once when told to', async () => {
    const email = createFakeEmail();
    await email.send({ to: 'a@example.test', subject: 'S', text: 'T' });
    email.failNext();
    await expect(email.send({ to: 'b@example.test', subject: 'S', text: 'T' })).rejects.toThrow(
      /refused/,
    );
    await email.send({ to: 'c@example.test', subject: 'S', text: 'T' });
    expect(email.sent.map((m) => m.to)).toEqual(['a@example.test', 'c@example.test']);
  });
});

describe('isEmailAddress', () => {
  it.each([
    ['a@example.test', true],
    ['not an address', false],
    ['', false],
    [null, false],
  ])('%j → %s', (value, expected) => {
    expect(isEmailAddress(value)).toBe(expected);
  });
});
