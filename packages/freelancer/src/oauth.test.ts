import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freelancerConfig, type FreelancerConfig } from './config.js';
import { startFakeFreelancer, type FakeFreelancer } from './fake.js';
import { FreelancerError } from './http.js';
import { authorizeUrl, exchangeCode, refreshTokens } from './oauth.js';
import { getSelf } from './users.js';

/**
 * ARB-020: the OAuth calls and the account lookup, against the stand-in over real HTTP.
 * The request shapes asserted here are the documented ones (links in oauth.ts and
 * users.ts); the stand-in answers in the documented shapes.
 */
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
let fake: FakeFreelancer;
let config: FreelancerConfig;

beforeAll(async () => {
  fake = await startFakeFreelancer({ user: { id: 424242, username: 'logiink' } });
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
});

afterAll(async () => {
  await fake.close();
});

describe('authorizeUrl', () => {
  it('is the documented authorise request: basic scope, the four advanced scopes, both prompts', () => {
    const sandbox = freelancerConfig({
      FREELANCER_BASE_URL: 'https://www.freelancer-sandbox.com',
      FREELANCER_CLIENT_ID: 'client 1',
      FREELANCER_CLIENT_SECRET: 's',
      FREELANCER_REDIRECT_URI: REDIRECT,
    });
    if (!sandbox.ok) throw new Error(sandbox.reason);
    expect(authorizeUrl(sandbox.config)).toBe(
      'https://accounts.freelancer-sandbox.com/oauth/authorize?response_type=code' +
        '&client_id=client%201' +
        '&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Ffreelancer-callback.html' +
        '&scope=basic&advanced_scopes=1%202%205%206&prompt=select_account%20consent',
    );
  });

  it('the stand-in accepts it and redirects back with a code', async () => {
    const response = await fetch(authorizeUrl(config), { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('code')).toMatch(/^code-/);
  });
});

describe('exchangeCode', () => {
  it('posts the five documented fields, form-encoded, and dates the expiry from expires_in', async () => {
    const code = fake.issueCode(REDIRECT);
    const tokens = await exchangeCode(config, code, { now: () => NOW });
    expect(tokens.accessToken).toMatch(/^access-/);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.scope).toBe('basic');
    // 2 592 000 s = 30 days after 23/09/2026 10:00 UTC.
    expect(tokens.expiresAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');

    const call = fake.calls.filter((c) => c.path === '/oauth/token').at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.form).toEqual({
      grant_type: 'authorization_code',
      code,
      client_id: fake.clientId,
      client_secret: fake.clientSecret,
      redirect_uri: REDIRECT,
    });
  });

  it('a code works once; the second use is a refusal with its HTTP status', async () => {
    const code = fake.issueCode(REDIRECT);
    await exchangeCode(config, code);
    const error = await exchangeCode(config, code).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreelancerError);
    expect((error as FreelancerError).status).toBe(400);
    expect((error as FreelancerError).message).toBe(
      'Freelancer.com refused the authorisation code (HTTP 400: Invalid authorisation code)',
    );
  });

  it('a wrong client secret is refused', async () => {
    const code = fake.issueCode(REDIRECT);
    const error = await exchangeCode({ ...config, clientSecret: 'wrong' }, code).catch(
      (e: unknown) => e,
    );
    expect((error as FreelancerError).status).toBe(401);
  });

  it('an unreachable server is reported as such, with status 0', async () => {
    const error = await exchangeCode({ ...config, accountsUrl: 'http://127.0.0.1:9' }, 'x').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FreelancerError);
    expect((error as FreelancerError).status).toBe(0);
    expect((error as FreelancerError).message).toMatch(/^Could not reach Freelancer\.com/);
  });
});

describe('refreshTokens', () => {
  it('trades the refresh token for new tokens; the old refresh token is then spent', async () => {
    const first = await exchangeCode(config, fake.issueCode(REDIRECT));
    const renewed = await refreshTokens(config, first.refreshToken!);
    expect(renewed.accessToken).not.toBe(first.accessToken);
    const call = fake.calls.filter((c) => c.path === '/oauth/token').at(-1)!;
    expect(call.form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
      client_id: fake.clientId,
    });
    expect(call.form.code).toBeUndefined();
    await expect(refreshTokens(config, first.refreshToken!)).rejects.toMatchObject({ status: 400 });
  });
});

describe('getSelf', () => {
  it('sends the token in freelancer-oauth-v1 and reads the user id and name', async () => {
    const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
    const self = await getSelf(config, tokens.accessToken);
    expect(self).toMatchObject({ id: '424242', username: 'logiink' });
    const call = fake.calls.filter((c) => c.path === '/api/users/0.1/self/').at(-1)!;
    expect(call.headers['freelancer-oauth-v1']).toBe(tokens.accessToken);
  });

  it('an expired token is an auth failure carrying the documented error code', async () => {
    const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
    fake.expireAccessTokens();
    const error = (await getSelf(config, tokens.accessToken).catch(
      (e: unknown) => e,
    )) as FreelancerError;
    expect(error.isAuthFailure).toBe(true);
    expect(error.errorCode).toBe('RestExceptionCodes.NOT_AUTHENTICATED');
    expect(error.requestId).toMatch(/^[0-9a-f]{32}$/);
    // The token is never part of what is reported.
    expect(error.message).not.toContain(tokens.accessToken);
  });
});
