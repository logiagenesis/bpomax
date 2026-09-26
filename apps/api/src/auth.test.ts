import { describe, expect, it, vi } from 'vitest';
import { CACHE_SIZE, DEFAULT_TTL_MS, bearerToken, supabaseAuthenticator } from './auth.js';

const USER = '11111111-2222-4333-8444-555555555555';

function fakeFetch(answer: (token: string | null) => { status: number; body?: unknown }) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? null;
    const { status, body } = answer(token);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('bearerToken', () => {
  it('reads the token and nothing else', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc.def' } })).toBe('abc.def');
    expect(bearerToken({ headers: { authorization: 'bearer  abc' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(bearerToken({ headers: {} })).toBeNull();
  });
});

describe('supabaseAuthenticator', () => {
  it('asks Supabase who the token belongs to, with the anon key, at the documented path', async () => {
    const fetch = fakeFetch((token) =>
      token === 'good' ? { status: 200, body: { id: USER } } : { status: 401 },
    );
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co/',
      anonKey: 'anon',
      fetch,
    });
    expect(await authenticate({ headers: { authorization: 'Bearer good' } })).toBe(USER);
    expect(fetch).toHaveBeenCalledWith('https://x.supabase.co/auth/v1/user', {
      headers: { apikey: 'anon', authorization: 'Bearer good' },
    });
    expect(await authenticate({ headers: { authorization: 'Bearer bad' } })).toBeNull();
    expect(await authenticate({ headers: {} })).toBeNull();
  });

  it('remembers a verified token for the TTL and forgets it after', async () => {
    let clock = 1_000;
    const fetch = fakeFetch(() => ({ status: 200, body: { id: USER } }));
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
      fetch,
      ttlMs: 60_000,
      now: () => clock,
    });
    const request = { headers: { authorization: 'Bearer good' } };
    await authenticate(request);
    await authenticate(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 60_001;
    await authenticate(request);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forgets a token after ten seconds by default (the owner audit, S-07)', async () => {
    expect(DEFAULT_TTL_MS).toBe(10_000);
    let clock = 1_000;
    const fetch = fakeFetch(() => ({ status: 200, body: { id: USER } }));
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
      fetch,
      now: () => clock,
    });
    const request = { headers: { authorization: 'Bearer good' } };
    await authenticate(request);
    clock += 9_999;
    await authenticate(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 2;
    await authenticate(request);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('when full, forgets the least recently used token, not the first one added', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { id: USER } }));
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
      fetch,
    });
    const as = (token: string) => authenticate({ headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < CACHE_SIZE; i += 1) await as(`t${String(i)}`);
    expect(fetch).toHaveBeenCalledTimes(CACHE_SIZE);
    // t0 is used again, so t1 is now the least recently used.
    await as('t0');
    expect(fetch).toHaveBeenCalledTimes(CACHE_SIZE);
    await as('newcomer');
    await as('t0');
    expect(fetch).toHaveBeenCalledTimes(CACHE_SIZE + 1);
    await as('t1');
    expect(fetch).toHaveBeenCalledTimes(CACHE_SIZE + 2);
  });

  it('does not remember a refusal, and treats an outage as an error rather than a stranger', async () => {
    let status = 401;
    const fetch = fakeFetch(() => ({ status, body: { id: USER } }));
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
      fetch,
    });
    const request = { headers: { authorization: 'Bearer t' } };
    expect(await authenticate(request)).toBeNull();
    status = 200;
    expect(await authenticate(request)).toBe(USER);
    status = 503;
    await expect(authenticate({ headers: { authorization: 'Bearer other' } })).rejects.toThrow(
      /503/,
    );
  });

  it('refuses a user record without a uuid id', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { id: 'not-a-uuid' } }));
    const authenticate = supabaseAuthenticator({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
      fetch,
    });
    expect(await authenticate({ headers: { authorization: 'Bearer t' } })).toBeNull();
  });
});
