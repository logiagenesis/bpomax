import { listEvents, putPlatformTokens, readPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UPWORK_PRODUCTION, upworkConfig, type UpworkConfig } from './config.js';
import { createFakeUpwork, sampleJob } from './fake.js';
import { UpworkError } from './http.js';
import { buildSearch, moneyOf, readJob, searchJobs, SEARCH_PAGE_SIZE } from './jobs.js';
import { authorizeUrl, exchangeCode, refreshTokens } from './oauth.js';
import { UpworkAccountNotConnectedError, upworkAccessToken } from './tokens.js';
import { currentUser } from './user.js';

/**
 * ARB-300: the Upwork client against a stand-in answering in the documented shapes
 * (docs.ts), and the token upkeep against real Postgres (the Vault shim, 0017).
 */
const ENV = {
  UPWORK_CLIENT_ID: 'client-id',
  UPWORK_CLIENT_SECRET: 'client-secret',
  APP_URL: 'http://localhost:5173',
};
const REDIRECT = 'http://localhost:5173/upwork-callback.html';
const ORG = fixtureId('a', ENTITY.org);
const ACCOUNT = fixtureId('e', 300);
const NOW = new Date('2026-09-24T08:00:00Z');

function standIn() {
  const fake = createFakeUpwork();
  const result = upworkConfig({ ...ENV, UPWORK_BASE_URL: fake.origin });
  if (!result.ok) throw new Error(result.reason);
  return { fake, config: result.config };
}

describe('upworkConfig', () => {
  it('names what is missing, and the key it comes from', () => {
    const result = upworkConfig({ UPWORK_CLIENT_ID: 'x' });
    expect(result).toMatchObject({
      ok: false,
      missing: ['UPWORK_CLIENT_SECRET', 'APP_URL'],
    });
    if (!result.ok) expect(result.reason).toContain('docs/02 B-14');
  });

  it('uses the documented hosts, and a stand-in only when one is named', () => {
    expect(upworkConfig(ENV)).toEqual({
      ok: true,
      config: {
        environment: 'production',
        ...UPWORK_PRODUCTION,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: REDIRECT,
      },
    });
    expect(UPWORK_PRODUCTION).toEqual({
      graphqlUrl: 'https://api.upwork.com/graphql',
      authorizeUrl: 'https://www.upwork.com/ab/account-security/oauth2/authorize',
      tokenUrl: 'https://www.upwork.com/api/v3/oauth2/token',
    });
    const standin = upworkConfig({ ...ENV, UPWORK_BASE_URL: 'http://127.0.0.1:4999/' });
    expect(standin).toMatchObject({
      ok: true,
      config: {
        environment: 'stand-in',
        graphqlUrl: 'http://127.0.0.1:4999/graphql',
        tokenUrl: 'http://127.0.0.1:4999/api/v3/oauth2/token',
      },
    });
    expect(upworkConfig({ ...ENV, UPWORK_BASE_URL: 'https://www.upwork.com' })).toMatchObject({
      ok: true,
      config: { environment: 'production' },
    });
    expect(upworkConfig({ ...ENV, UPWORK_BASE_URL: 'not a url' })).toMatchObject({ ok: false });
    // The callback is this app's page, whether APP_URL ends in a slash or not.
    expect(upworkConfig({ ...ENV, APP_URL: 'https://app.example.test/' })).toMatchObject({
      config: { redirectUri: 'https://app.example.test/upwork-callback.html' },
    });
  });
});

describe('OAuth', () => {
  it('sends the person to the documented authorise URL with code, client and redirect only', () => {
    const { config } = standIn();
    const url = new URL(authorizeUrl({ ...config, ...UPWORK_PRODUCTION }));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.upwork.com/ab/account-security/oauth2/authorize',
    );
    expect([...url.searchParams.keys()]).toEqual(['response_type', 'client_id', 'redirect_uri']);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });

  it('trades the code for tokens lasting expires_in, and refreshes with the documented fields', async () => {
    const { fake, config } = standIn();
    const tokens = await exchangeCode(config, 'code-ok', { fetch: fake.fetch, now: () => NOW });
    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date('2026-09-25T08:00:00Z'),
    });
    expect(fake.state.calls[0]?.body).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'code-ok',
      redirect_uri: REDIRECT,
    });
    const renewed = await refreshTokens(config, 'refresh-1', { fetch: fake.fetch, now: () => NOW });
    expect(renewed.accessToken).toBe('access-2');
    expect(fake.state.calls[1]?.body).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-1',
    });
    await expect(exchangeCode(config, 'code-ok', { fetch: fake.fetch })).rejects.toMatchObject({
      name: 'UpworkError',
      status: 400,
    });
  });
});

describe('the current user', () => {
  it('asks for the id and name only, with the token as a Bearer token', async () => {
    const { fake, config } = standIn();
    fake.state.accepted.add('tok');
    expect(await currentUser(config, 'tok', { fetch: fake.fetch })).toEqual({
      id: 'up-user-1',
      name: 'Sample Upwork user',
    });
    expect(fake.state.calls[0]?.headers.authorization).toBe('Bearer tok');
    await expect(currentUser(config, 'wrong', { fetch: fake.fetch })).rejects.toMatchObject({
      status: 401,
      isAuthFailure: true,
    });
  });
});

describe('the job search', () => {
  it('sends the scanner as the documented filter, newest first, one page', () => {
    const built = buildSearch({ keywords: [' wordpress ', 'php'], hourly: false });
    expect(built.filter).toEqual({
      searchExpression_eq: 'wordpress php',
      jobType_eq: 'FIXED',
      pagination_eq: { after: '0', first: SEARCH_PAGE_SIZE },
    });
    expect(built.notApplied).toEqual([]);
    expect(
      buildSearch({ clientCountriesInclude: ['ZA'], categorySlugs: ['web'], budgetMinMinor: 100 })
        .notApplied,
    ).toEqual(['budgetMinMinor', 'clientCountriesInclude', 'categorySlugs']);
  });

  it('keeps fixed listings at or over the floor in its currency, and every hourly one', () => {
    const { keep } = buildSearch({ budgetMinMinor: 50_000, currency: 'USD' });
    const job = (fields: Record<string, unknown>) => readJob(sampleJob(1, fields))!;
    expect(keep(job({ amount: { rawValue: '500.0', currency: 'USD' } }))).toBe(true);
    expect(keep(job({ amount: { rawValue: '499.99', currency: 'USD' } }))).toBe(false);
    expect(keep(job({ amount: { rawValue: '10', currency: 'EUR' } }))).toBe(true);
    expect(
      keep(
        job({
          amount: null,
          hourlyBudgetMin: { rawValue: '5', currency: 'USD' },
          job: { contractTerms: { contractType: 'HOURLY' } },
        }),
      ),
    ).toBe(true);
  });

  it('reads Money as text into minor units, half up, with no float', () => {
    expect(moneyOf({ rawValue: '1.23', currency: 'usd' })).toEqual({ currency: 'USD', minor: 123 });
    expect(moneyOf({ rawValue: '1.235', currency: 'USD' })).toEqual({
      currency: 'USD',
      minor: 124,
    });
    expect(moneyOf({ rawValue: '500.0', currency: 'USD' })).toEqual({
      currency: 'USD',
      minor: 50_000,
    });
    expect(moneyOf({ rawValue: '1000', currency: 'JPY' })).toEqual({
      currency: 'JPY',
      minor: 1000,
    });
    expect(moneyOf({ rawValue: '$1.23', currency: 'USD' })).toBeNull();
    expect(moneyOf(null)).toBeNull();
  });

  it('reads a listing: the contract type, the budget of that type, the client, the date', () => {
    const fixed = readJob(sampleJob(7))!;
    expect(fixed).toMatchObject({
      id: '~01007',
      hourly: false,
      fixed: { currency: 'USD', minor: 50_000 },
      hourlyMin: null,
      skills: ['wordpress', 'php'],
      applicants: 3,
      clientPaymentVerified: true,
      clientTotalSpent: { currency: 'USD', minor: 1_234_567 },
      publishedAt: new Date('2026-09-24T06:00:00.000Z'),
    });
    const hourly = readJob(
      sampleJob(8, {
        amount: null,
        job: null,
        hourlyBudgetMin: { rawValue: '15', currency: 'USD' },
        hourlyBudgetMax: { rawValue: '30', currency: 'USD' },
        client: { verificationStatus: 'UNKNOWN' },
      }),
    )!;
    // No contract type: `amount` is "null for hourly jobs" and an hourly budget is given.
    expect(hourly).toMatchObject({
      hourly: true,
      fixed: null,
      hourlyMin: { minor: 1500 },
      hourlyMax: { minor: 3000 },
      clientPaymentVerified: null,
      clientTotalSpent: null,
    });
    expect(readJob({ title: 'no id' })).toBeNull();
  });

  it('calls marketplaceJobPostingsSearch with the documented arguments and reads the page', async () => {
    const { fake, config } = standIn();
    fake.state.accepted.add('tok');
    fake.state.jobs = [
      sampleJob(1),
      sampleJob(2, { title: 'Logo design', description: 'A logo.' }),
      sampleJob(3),
    ];
    const page = await searchJobs(config, 'tok', buildSearch({ keywords: ['sample'] }).filter, {
      fetch: fake.fetch,
      tenantId: 'org-9',
    });
    expect(page.jobs.map((j) => j.id)).toEqual(['~01001', '~01003']);
    expect(page.totalCount).toBe(2);
    const call = fake.state.calls[0]!;
    expect(call.headers['x-upwork-api-tenantid']).toBe('org-9');
    expect(call.body).toMatchObject({
      variables: {
        searchType: 'USER_JOBS_SEARCH',
        sortAttributes: [{ field: 'RECENCY' }],
        marketPlaceJobFilter: { searchExpression_eq: 'sample' },
      },
    });
  });

  it('reports a rate limit and a missing permission as such', async () => {
    const { fake, config } = standIn();
    fake.state.accepted.add('tok');
    fake.state.rateLimitNext = true;
    const limited = await searchJobs(config, 'tok', buildSearch({}).filter, {
      fetch: fake.fetch,
    }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(UpworkError);
    expect((limited as UpworkError).isRateLimited).toBe(true);
    fake.state.permissionMissingNext = true;
    const refused = await searchJobs(config, 'tok', buildSearch({}).filter, {
      fetch: fake.fetch,
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ permission: true, isAuthFailure: true });
    expect((refused as Error).message).toContain('permissions/scopes');
  });
});

describe('upworkAccessToken', () => {
  let db: PGlite;
  let config: UpworkConfig;
  let fake: ReturnType<typeof createFakeUpwork>;

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const row of identityRows('a')) await db.exec(row.sql);
    for (const row of tenantRows(ORG, 'a', 'a')) {
      if (row.table === 'memberships') await db.exec(row.sql);
    }
    await db.query(
      `insert into platform_accounts (id, org_id, platform, external_user_id, status) values ($1, $2, 'upwork', 'up-user-1', 'connected')`,
      [ACCOUNT, ORG],
    );
    ({ fake, config } = standIn());
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('delete from events');
    await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  });

  async function store(expiresAt: Date) {
    const tokens = await exchangeCode(config, 'code-ok', { fetch: fake.fetch });
    fake.state.codes.add('code-ok');
    await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt });
    return tokens;
  }

  it('hands back the stored token while it has over an hour left, calling nobody', async () => {
    const tokens = await store(new Date('2026-09-24T09:00:01Z'));
    const before = fake.state.calls.length;
    expect(
      await upworkAccessToken({ db, config, fetch: fake.fetch, now: () => NOW }, ACCOUNT),
    ).toBe(tokens.accessToken);
    expect(fake.state.calls.length).toBe(before);
  });

  it('refreshes a token with an hour or less left, stores the new one and logs it', async () => {
    const tokens = await store(new Date('2026-09-24T09:00:00Z'));
    const token = await upworkAccessToken(
      { db, config, fetch: fake.fetch, now: () => NOW },
      ACCOUNT,
    );
    expect(token).not.toBe(tokens.accessToken);
    expect((await readPlatformTokens(db, ACCOUNT))?.accessToken).toBe(token);
    const events = await listEvents(db, { type: 'account.token_refreshed' });
    expect(events[0]).toMatchObject({ outcome: 'ok', payload: { platform: 'upwork' } });
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('marks the account expired when Upwork refuses the refresh', async () => {
    await store(new Date('2026-09-24T08:30:00Z'));
    fake.state.refreshable.clear();
    await expect(
      upworkAccessToken({ db, config, fetch: fake.fetch, now: () => NOW }, ACCOUNT),
    ).rejects.toBeInstanceOf(UpworkAccountNotConnectedError);
    const { rows } = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT],
    );
    expect(rows[0]?.status).toBe('expired');
  });

  it('refuses an account that is not a connected Upwork account', async () => {
    await expect(
      upworkAccessToken({ db, config, now: () => NOW }, fixtureId('a', ENTITY.platformAccount)),
    ).rejects.toThrow('no such Upwork account');
  });
});
