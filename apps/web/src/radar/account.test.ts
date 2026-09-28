import { describe, expect, it } from 'vitest';
import {
  SELF_URL,
  fetchSelf,
  maskToken,
  normaliseAccount,
  tokenProblem,
  tokenState,
  type StoredToken,
} from './account.js';
import { DEFAULT_SETTINGS, backupOf } from './store.js';

/**
 * The Freelancer token (LI-PROMPT-BPOMAX-AUTOBID-20260928, step 1 and constraint 2). The
 * answers below are hand-built in the shape GET /users/0.1/self/ gave on 28/09/2026 (id,
 * username, role, limited_account, membership_package with name, bid_limit and
 * duration_type), with a made-up user; the 401 is the one Freelancer.com gives any token it
 * does not accept (checked 28/09/2026 with no token and with a wrong one).
 */
const SELF = {
  status: 'success',
  result: {
    id: 1234567,
    username: 'example-user',
    role: 'freelancer',
    limited_account: false,
    membership_package: { name: 'plus', bid_limit: 100, duration_type: 'month' },
  },
};
const REFUSED = {
  status: 'error',
  message: 'You must be logged in to perform this request',
  error_code: 'RestExceptionCodes.NOT_AUTHENTICATED',
};
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789WXYZ';

describe('who the token belongs to', () => {
  it('reads the account and its membership', () => {
    expect(normaliseAccount(SELF.result)).toEqual({
      id: 1234567,
      username: 'example-user',
      role: 'freelancer',
      limited: false,
      membership: 'plus',
      bidLimit: 100,
      bidPeriod: 'month',
    });
  });

  it('survives an answer with no membership', () => {
    expect(normaliseAccount({ id: 5, username: 'x' })).toMatchObject({
      membership: null,
      bidLimit: null,
      bidPeriod: null,
      limited: false,
      role: null,
    });
  });

  it('sends the token only in the freelancer-oauth-v1 header, to the self endpoint', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(SELF));
    };
    const account = await fetchSelf(TOKEN, fake as unknown as typeof fetch);
    expect(account.username).toBe('example-user');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://www.freelancer.com/api/users/0.1/self/?membership_details=true',
    );
    expect(SELF_URL).not.toContain(TOKEN);
    expect(calls[0]!.init?.headers).toEqual({
      accept: 'application/json',
      'freelancer-oauth-v1': TOKEN,
    });
  });

  it('a refused token throws with the status, and never repeats the token', async () => {
    const fake = async () => new Response(JSON.stringify(REFUSED), { status: 401 });
    const error = await fetchSelf(TOKEN, fake as unknown as typeof fetch).catch((e) => e);
    expect(error).toMatchObject({
      status: 401,
      message: 'Freelancer.com answered HTTP 401: You must be logged in to perform this request.',
    });
    expect(String(error.message)).not.toContain(TOKEN);
  });

  it('an answer without an id or username is not taken as an account', async () => {
    const fake = async () => new Response(JSON.stringify({ status: 'success', result: {} }));
    await expect(fetchSelf(TOKEN, fake as unknown as typeof fetch)).rejects.toThrow(
      'without a user id and username',
    );
  });
});

describe('what a pasted token must look like', () => {
  it.each([
    ['', 'Paste the token first.'],
    ['abc def ghi jkl mno pqr stu', 'A token has no spaces in it. Paste it again, on its own.'],
    ['short', 'That is too short to be a token. Paste the whole of it.'],
    [TOKEN, null],
  ])('%j → %j', (token, problem) => {
    expect(tokenProblem(token)).toBe(problem);
  });

  it('shows only the last four characters', () => {
    expect(maskToken(TOKEN)).toBe('••••••••WXYZ');
  });
});

describe('the 30 days and the warning 5 days before', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Pasted 28/09/2026 09:00 SAST.
  const savedAt = Date.UTC(2026, 8, 28, 7, 0);
  const token: StoredToken = {
    token: TOKEN,
    savedAt,
    account: null,
    checkedAt: null,
    problem: null,
  };

  it('no token', () => {
    expect(tokenState(null, savedAt)).toEqual({ kind: 'none', expiresAt: null, daysLeft: null });
  });

  it.each([
    [0, 'ok', 30],
    [24.5, 'ok', 6],
    [25, 'soon', 5],
    [29.9, 'soon', 1],
    [30, 'expired', 0],
    [45, 'expired', 0],
  ])('%d days after pasting → %s, %d days left', (days, kind, left) => {
    expect(tokenState(token, savedAt + days * DAY)).toEqual({
      kind,
      expiresAt: savedAt + 30 * DAY,
      daysLeft: left,
    });
  });
});

describe('the token never leaves in a backup', () => {
  it('Export carries settings, templates, log, dismissed and shortlist only', () => {
    const backup = backupOf(
      { settings: DEFAULT_SETTINGS, templates: [], log: [], dismissed: [], shortlist: [] },
      Date.UTC(2026, 8, 28),
    );
    expect(Object.keys(backup).sort()).toEqual([
      'dismissed',
      'exportedAt',
      'format',
      'log',
      'settings',
      'shortlist',
      'templates',
      'version',
    ]);
    expect(JSON.stringify(backup)).not.toContain('token');
  });
});
