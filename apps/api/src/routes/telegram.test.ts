import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { newLinkCode } from './telegram.js';

/** ARB-050: the one-time code a person gets in Settings and sends to the bot. */
let db: PGlite;
let app: FastifyInstance;
const ORG_A = fixtureId('a', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);

function authenticateFromHeader(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['x-test-auth-user'];
  return typeof header === 'string' ? header : null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  // b is a viewer in a's org: may read, may not write.
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [
    ORG_A,
    fixtureId('b', ENTITY.user),
  ]);
  app = buildServer({
    db,
    authenticate: (request) =>
      authenticateFromHeader(request as unknown as { headers: Record<string, unknown> }),
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('POST /v1/telegram/link-codes', () => {
  it('turns away a request with no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/telegram/link-codes' });
    expect(response.statusCode).toBe(401);
  });

  it('gives an owner a one-time code that expires, and records it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/telegram/link-codes',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    const { rows } = await db.query<{ user_id: string; used_at: string | null }>(
      'select user_id, used_at from telegram_link_codes where code = $1',
      [body.code],
    );
    expect(rows).toEqual([{ user_id: fixtureId('a', ENTITY.user), used_at: null }]);
    const events = await db.query<{ payload: { what: string } }>(
      `select payload from events where type = 'settings.changed' and subject_table = 'telegram_link_codes'`,
    );
    expect(events.rows.at(-1)?.payload.what).toBe('telegram_link_code_created');
  });

  it('refuses a viewer, by row-level security', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/telegram/link-codes',
      headers: { 'x-test-auth-user': AUTH_B },
    });
    expect(response.statusCode).toBe(403);
  });

  it('never repeats itself', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newLinkCode()));
    expect(codes.size).toBe(200);
  });
});
