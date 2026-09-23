import { listEvents, putPlatformTokens, readPlatformTokens } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freelancerConfig, type FreelancerConfig } from './config.js';
import { startFakeFreelancer, type FakeFreelancer } from './fake.js';
import { exchangeCode } from './oauth.js';
import { AccountNotConnectedError, freelancerAccessToken } from './tokens.js';

/**
 * ARB-020: a worker's access token, refreshed a day before it lapses. Real Postgres for
 * the tokens (the Vault shim, 0017) and the stand-in over HTTP for the refresh.
 */
const ORG = fixtureId('a', ENTITY.org);
const ACCOUNT = fixtureId('a', ENTITY.platformAccount);
const REDIRECT = 'http://localhost:5173/freelancer-callback.html';
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let fake: FakeFreelancer;
let config: FreelancerConfig;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) {
    if (row.table === 'platform_accounts' || row.table === 'memberships') await db.exec(row.sql);
  }
  fake = await startFakeFreelancer();
  const result = freelancerConfig({
    FREELANCER_BASE_URL: fake.url,
    FREELANCER_CLIENT_ID: fake.clientId,
    FREELANCER_CLIENT_SECRET: fake.clientSecret,
    FREELANCER_REDIRECT_URI: REDIRECT,
  });
  if (!result.ok) throw new Error(result.reason);
  config = result.config;
}, 60_000);

afterAll(async () => {
  await fake.close();
  await db.close();
});

/** Connects the account with real tokens from the stand-in, expiring at `expiresAt`. */
async function connect(expiresAt: Date): Promise<{ accessToken: string }> {
  const tokens = await exchangeCode(config, fake.issueCode(REDIRECT));
  await db.query(`update platform_accounts set status = 'connected' where id = $1`, [ACCOUNT]);
  await putPlatformTokens(db, ACCOUNT, { ...tokens, expiresAt });
  return tokens;
}

beforeEach(async () => {
  await db.query('delete from events');
});

describe('freelancerAccessToken', () => {
  it('hands back the stored token while it has more than a day left, calling nobody', async () => {
    const { accessToken } = await connect(new Date('2026-09-24T10:00:01Z'));
    const before = fake.calls.length;
    expect(await freelancerAccessToken({ db, config, now: () => NOW }, ACCOUNT)).toBe(accessToken);
    expect(fake.calls.length).toBe(before);
  });

  it('refreshes a token with a day or less left, stores the new pair, and logs it', async () => {
    const { accessToken } = await connect(new Date('2026-09-24T10:00:00Z'));
    const renewed = await freelancerAccessToken({ db, config, now: () => NOW }, ACCOUNT);
    expect(renewed).not.toBe(accessToken);
    const stored = await readPlatformTokens(db, ACCOUNT);
    expect(stored?.accessToken).toBe(renewed);
    // 30 days from 23/09/2026 10:00 UTC.
    expect(stored?.expiresAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    const [event] = await listEvents(db, { type: 'account.token_refreshed' });
    expect(event).toMatchObject({ outcome: 'ok', subject_id: ACCOUNT, actor_kind: 'system' });
    expect(JSON.stringify(event?.payload)).not.toContain(renewed);
  });

  it('marks the account expired when Freelancer.com refuses the refresh, and says what to do', async () => {
    await connect(new Date('2026-09-23T11:00:00Z'));
    fake.revokeRefreshTokens();
    const error = await freelancerAccessToken({ db, config, now: () => NOW }, ACCOUNT).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AccountNotConnectedError);
    expect((error as Error).message).toMatch(/connect the account again in Settings/);
    const { rows } = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT],
    );
    expect(rows[0]?.status).toBe('expired');
    const [event] = await listEvents(db, { type: 'account.token_refreshed' });
    expect(event?.outcome).toBe('error');
  });

  it('refuses an account that is not connected, before reading any token', async () => {
    await expect(freelancerAccessToken({ db, config, now: () => NOW }, ACCOUNT)).rejects.toThrow(
      /is expired; connect it again in Settings/,
    );
  });

  it('leaves the account connected when the refresh fails for want of a network', async () => {
    await connect(new Date('2026-09-23T11:00:00Z'));
    const unreachable = { ...config, accountsUrl: 'http://127.0.0.1:9' };
    await expect(
      freelancerAccessToken({ db, config: unreachable, now: () => NOW }, ACCOUNT),
    ).rejects.toMatchObject({ status: 0 });
    const { rows } = await db.query<{ status: string }>(
      'select status::text as status from platform_accounts where id = $1',
      [ACCOUNT],
    );
    expect(rows[0]?.status).toBe('connected');
  });
});
