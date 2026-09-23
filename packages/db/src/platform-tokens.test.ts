import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from './client.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import {
  connectPlatformTokens,
  disconnectPlatformAccount,
  putPlatformTokens,
  readPlatformTokens,
} from './platform-tokens.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-020: tokens are held in Vault and reached only through migration 0017's functions.
 * The shim stores secrets unencrypted, so what is proven here is the access rule: who
 * may write, who may read, and that the account row never holds a token. Encryption
 * itself is proven on the real extension in CI (scripts/db-verify-vault.sql, D-041).
 */
let db: PGlite;

const ORG_A = fixtureId('a', ENTITY.org);
const ACCOUNT_A = fixtureId('a', ENTITY.platformAccount);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const EXPIRES = new Date('2026-10-23T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(fixtureId('b', ENTITY.org), 'b', 'b')) await db.exec(row.sql);
  for (const [tag, role] of [
    ['c', 'viewer'],
    ['d', 'operator'],
  ] as const) {
    await db.exec(`insert into users (id, auth_user_id, email) values
      ('${fixtureId(tag, ENTITY.user)}', '${fixtureId(tag, ENTITY.authUser)}', '${tag}@example.test')`);
    await db.exec(`insert into memberships (org_id, user_id, role) values
      ('${ORG_A}', '${fixtureId(tag, ENTITY.user)}', '${role}')`);
  }
}, 60_000);

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

async function secretCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from vault.secrets');
  return rows[0]?.n ?? 0;
}

describe('connecting', () => {
  it('an operator stores both tokens in Vault; the account row holds only their ids', async () => {
    await withUser(db, AUTH_OPERATOR, (tx) =>
      connectPlatformTokens(tx, ACCOUNT_A, {
        accessToken: 'access-one',
        refreshToken: 'refresh-one',
        expiresAt: EXPIRES,
      }),
    );
    expect(await secretCount()).toBe(2);
    const { rows } = await db.query<Record<string, unknown>>(
      'select * from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(rows[0]).toMatchObject({ status: 'connected' });
    expect(rows[0]?.access_token_secret_id).toEqual(expect.any(String));
    expect(rows[0]?.refresh_token_secret_id).toEqual(expect.any(String));
    expect(JSON.stringify(rows[0])).not.toMatch(/access-one|refresh-one/);
    expect(await readPlatformTokens(db, ACCOUNT_A)).toEqual({
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      expiresAt: EXPIRES,
    });
  });

  it('a second connect updates the same two secrets rather than adding more', async () => {
    await withUser(db, AUTH_A, (tx) =>
      connectPlatformTokens(tx, ACCOUNT_A, {
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        expiresAt: EXPIRES,
      }),
    );
    expect(await secretCount()).toBe(2);
    expect((await readPlatformTokens(db, ACCOUNT_A))?.accessToken).toBe('access-two');
  });

  it('a refresh with no new refresh token keeps the stored one', async () => {
    await putPlatformTokens(db, ACCOUNT_A, {
      accessToken: 'access-three',
      refreshToken: null,
      expiresAt: EXPIRES,
    });
    expect(await readPlatformTokens(db, ACCOUNT_A)).toMatchObject({
      accessToken: 'access-three',
      refreshToken: 'refresh-two',
    });
  });

  it('refuses a viewer and another org, and changes nothing', async () => {
    for (const who of [AUTH_VIEWER, AUTH_B]) {
      await expect(
        withUser(db, who, (tx) =>
          connectPlatformTokens(tx, ACCOUNT_A, {
            accessToken: 'stolen',
            refreshToken: 'stolen',
            expiresAt: null,
          }),
        ),
      ).rejects.toThrow(/refused/);
    }
    expect((await readPlatformTokens(db, ACCOUNT_A))?.accessToken).toBe('access-three');
  });
});

describe('reading', () => {
  it('no signed-in person can read a token back, not even the owner', async () => {
    await signIn(db, AUTH_A);
    await expect(db.query('select * from app.platform_tokens($1)', [ACCOUNT_A])).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query('select * from vault.decrypted_secrets')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.query(`select app.put_platform_tokens($1, 'x', 'y', null)`, [ACCOUNT_A]),
    ).rejects.toThrow(/permission denied/);
  });

  it('service_role can', async () => {
    await db.exec('set role service_role');
    const { rows } = await db.query<{ access_token: string }>(
      'select access_token from app.platform_tokens($1)',
      [ACCOUNT_A],
    );
    expect(rows[0]?.access_token).toBe('access-three');
  });
});

describe('disconnecting', () => {
  it('refuses a viewer', async () => {
    await expect(
      withUser(db, AUTH_VIEWER, (tx) => disconnectPlatformAccount(tx, ACCOUNT_A)),
    ).rejects.toThrow(/refused/);
    expect(await secretCount()).toBe(2);
  });

  it('deletes both secrets and marks the account disconnected, keeping the row', async () => {
    await withUser(db, AUTH_OPERATOR, (tx) => disconnectPlatformAccount(tx, ACCOUNT_A));
    expect(await secretCount()).toBe(0);
    expect(await readPlatformTokens(db, ACCOUNT_A)).toBeNull();
    const { rows } = await db.query<{ status: string; token_expires_at: string | null }>(
      'select status, token_expires_at from platform_accounts where id = $1',
      [ACCOUNT_A],
    );
    expect(rows[0]).toEqual({ status: 'disconnected', token_expires_at: null });
  });
});
