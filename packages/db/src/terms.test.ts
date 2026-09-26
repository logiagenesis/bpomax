import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from './fixtures.js';
import { currentTermsVersion, recordPublishedTerms } from './terms.js';
import { createTestDatabase, signIn, signOut } from './testing.js';

/**
 * ARB-522, the owner's audit P-08: `app.create_org` makes an org only for a person who
 * accepts the terms of service on show, and records that they did (migration 0039).
 */
let db: PGlite;
const AUTH_A = fixtureId('a', ENTITY.authUser);
const people = ['c', 'd', 'e', 'f'].map((tag) => ({
  user: fixtureId(tag, ENTITY.user),
  auth: fixtureId(tag, ENTITY.authUser),
}));

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const [i, p] of people.entries()) {
    await db.query(`insert into users (id, auth_user_id, email) values ($1, $2, $3)`, [
      p.user,
      p.auth,
      `person${String(i)}@example.test`,
    ]);
  }
}, 60_000);

afterEach(async () => {
  await signOut(db);
});

afterAll(async () => {
  await db.close();
});

async function createOrg(auth: string, terms: string | null): Promise<string> {
  await signIn(db, auth);
  try {
    const { rows } = await db.query<{ id: string }>(
      `select app.create_org('Studio', 'ZA', 'req-terms', null, $1) as id`,
      [terms],
    );
    return rows[0]!.id;
  } finally {
    await signOut(db);
  }
}

describe('making an org needs the terms of service', () => {
  it('refuses everyone while no terms are published', async () => {
    expect(await currentTermsVersion(db)).toBeNull();
    await expect(createOrg(people[0]!.auth, 'v1')).rejects.toThrow(
      /terms of service are not published yet/,
    );
    await expect(createOrg(people[0]!.auth, null)).rejects.toThrow(/not published yet/);
  });

  it('once published, refuses a person who names no version, or another one', async () => {
    expect(await recordPublishedTerms(db, { version: 'v1', approvedOn: '2026-10-01' })).toBe(true);
    await expect(createOrg(people[0]!.auth, null)).rejects.toThrow(
      /accept the current terms of service first/,
    );
    await expect(createOrg(people[0]!.auth, 'v0')).rejects.toThrow(/accept the current terms/);
    const { rows } = await db.query(`select id from memberships where user_id = $1`, [
      people[0]!.user,
    ]);
    expect(rows).toEqual([]);
  });

  it('makes the org for a person who accepts the version on show, and records it', async () => {
    const org = await createOrg(people[0]!.auth, 'v1');
    const { rows } = await db.query<{ version: string; request_id: string }>(
      `select version, request_id from terms_acceptances where user_id = $1`,
      [people[0]!.user],
    );
    expect(rows).toEqual([{ version: 'v1', request_id: 'req-terms' }]);
    const event = await db.query<{ payload: unknown }>(
      `select payload from events where org_id = $1 and type = 'org.created'`,
      [org],
    );
    expect(event.rows).toEqual([
      { payload: { name: 'Studio', countryCode: 'ZA', termsVersion: 'v1' } },
    ]);
  });

  it('after new terms are published, only the newest is accepted', async () => {
    expect(await recordPublishedTerms(db, { version: 'v1', approvedOn: '2026-10-01' })).toBe(false);
    await recordPublishedTerms(db, { version: 'v2', approvedOn: '2026-11-15' });
    expect(await currentTermsVersion(db)).toBe('v2');
    await expect(createOrg(people[1]!.auth, 'v1')).rejects.toThrow(/accept the current terms/);
    await createOrg(people[1]!.auth, 'v2');
  });
});

describe('who may see and write acceptances', () => {
  it('a person sees their own acceptance and nobody else s', async () => {
    await signIn(db, people[0]!.auth);
    const { rows } = await db.query<{ user_id: string }>(`select user_id from terms_acceptances`);
    expect(rows.map((r) => r.user_id)).toEqual([people[0]!.user]);
  });

  it('nobody signed in writes an acceptance or a version by hand', async () => {
    await signIn(db, people[2]!.auth);
    await expect(
      db.query(`insert into terms_acceptances (user_id, version) values ($1, 'v2')`, [
        people[2]!.user,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(`insert into terms_versions (version, approved_on) values ('v9', '2027-01-01')`),
    ).rejects.toThrow(/permission denied/);
    await signOut(db);
    await signIn(db, AUTH_A);
    const { rows } = await db.query<{ version: string }>(
      `select version from terms_versions order by version`,
    );
    expect(rows.map((r) => r.version)).toEqual(['v1', 'v2']);
  });
});
