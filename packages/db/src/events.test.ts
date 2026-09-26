import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from './client.js';
import { listEvents, listEventsForRequest, recordEvent, textFingerprint } from './events.js';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from './fixtures.js';
import { createTestDatabase } from './testing.js';

/**
 * ARB-014: the audit log writer and reader.
 *
 * The reader takes no org_id. Everything it returns is scoped by row level security, so
 * these tests are as much about the boundary as about the query.
 */
let db: PGlite;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const USER_A = fixtureId('a', ENTITY.user);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('recordEvent', () => {
  it('writes an event and hands back its id', async () => {
    const id = await recordEvent(db, {
      orgId: ORG_A,
      type: 'job.ingested',
      subjectTable: 'jobs',
      subjectId: fixtureId('a', ENTITY.job),
      payload: { external_id: 'job-a' },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const [event] = await listEvents(db, { subjectId: fixtureId('a', ENTITY.job) });
    expect(event?.type).toBe('job.ingested');
    expect(event?.actor_kind).toBe('system');
    expect(event?.payload).toEqual({ external_id: 'job-a' });
    expect(event?.outcome).toBe('ok');
  });

  it('refuses a type that is not in the vocabulary', async () => {
    await expect(
      // @ts-expect-error — the point of the test is the runtime guard behind the type.
      recordEvent(db, { orgId: ORG_A, type: 'job.quietly_invented' }),
    ).rejects.toThrow(/unknown event type/i);
  });

  it('refuses a user action with no user, and a system action with one', async () => {
    await expect(
      recordEvent(db, { orgId: ORG_A, type: 'settings.changed', actorKind: 'user' }),
    ).rejects.toThrow(/names no user/i);

    await expect(
      recordEvent(db, {
        orgId: ORG_A,
        type: 'settings.changed',
        actorKind: 'system',
        actorUserId: USER_A,
      }),
    ).rejects.toThrow(/names a user/i);
  });

  it('records what a blocked outbound call would have sent', async () => {
    const requestId = 'req-live-mode-1';
    await recordEvent(db, {
      orgId: ORG_A,
      type: 'external.blocked_by_live_mode',
      outcome: 'blocked',
      requestId,
      payload: { endpoint: 'POST /projects/0.1/bids', amount_minor: 200000 },
    });

    const [event] = await listEventsForRequest(db, requestId);
    expect(event?.outcome).toBe('blocked');
    expect(event?.payload).toMatchObject({ endpoint: 'POST /projects/0.1/bids' });
  });
});

describe('listEvents', () => {
  beforeAll(async () => {
    for (const org of [ORG_A, ORG_B]) {
      await recordEvent(db, { orgId: org, type: 'proposal.drafted', outcome: 'ok' });
      await recordEvent(db, { orgId: org, type: 'proposal.submitted', outcome: 'error' });
    }
  });

  it('shows a member only their own org s events', async () => {
    const mine = await withUser(db, AUTH_B, (tx) => listEvents(tx));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((event) => event.org_id === ORG_B)).toBe(true);
  });

  it('filters by type, outcome and time', async () => {
    const byType = await withUser(db, AUTH_A, (tx) =>
      listEvents(tx, { type: 'proposal.submitted' }),
    );
    expect(byType.every((event) => event.type === 'proposal.submitted')).toBe(true);
    expect(byType.length).toBeGreaterThan(0);

    const failures = await withUser(db, AUTH_A, (tx) => listEvents(tx, { outcome: 'error' }));
    expect(failures.every((event) => event.outcome === 'error')).toBe(true);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await withUser(db, AUTH_A, (tx) => listEvents(tx, { from: future }));
    expect(none).toEqual([]);
  });

  it('returns the newest first and pages', async () => {
    const page = await withUser(db, AUTH_A, (tx) => listEvents(tx, { limit: 2 }));
    expect(page).toHaveLength(2);
    expect(Date.parse(page[0]!.created_at)).toBeGreaterThanOrEqual(Date.parse(page[1]!.created_at));

    const next = await withUser(db, AUTH_A, (tx) => listEvents(tx, { limit: 2, offset: 2 }));
    expect(next.map((e) => e.id)).not.toEqual(page.map((e) => e.id));
  });

  it('refuses an invented type in a filter rather than returning nothing', async () => {
    await expect(
      // @ts-expect-error — a typo must not quietly read as "no results".
      withUser(db, AUTH_A, (tx) => listEvents(tx, { type: 'proposal.invented' })),
    ).rejects.toThrow(/unknown event type/i);
  });
});

describe('the log as a whole', () => {
  it('cannot be rewritten through the writer or anything else', async () => {
    await withUser(db, AUTH_A, async (tx) => {
      const updated = await tx.query(`update events set type = 'settings.changed'`);
      expect(updated.affectedRows).toBe(0);
      const deleted = await tx.query(`delete from events`);
      expect(deleted.affectedRows).toBe(0);
    });
  });

  it('tells the caller when a write was refused instead of reporting success', async () => {
    // Org B's owner writing into org A: RLS returns no row, which must not read as "done".
    await expect(
      withUser(db, AUTH_B, (tx) => recordEvent(tx, { orgId: ORG_A, type: 'settings.changed' })),
    ).rejects.toThrow(/row-level security|was not recorded/i);
  });
});

describe('textFingerprint (ARB-520, the owner audit P-02)', () => {
  it('keeps the length and the SHA-256 of a text, never the words', () => {
    // The SHA-256 of "abc" is the FIPS 180-2 test vector.
    expect(textFingerprint('abc')).toEqual({
      chars: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    const fingerprint = textFingerprint('Hi Thandi, can you start on Monday?');
    expect(JSON.stringify(fingerprint)).not.toContain('Thandi');
    expect(fingerprint.chars).toBe(35);
  });
});
