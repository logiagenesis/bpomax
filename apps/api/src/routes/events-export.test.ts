import { recordEvent } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { EXPORT_ROW_CAP, csvCell, eventsToCsv } from './events-csv.js';

/** ARB-062: the audit log page's actor list and CSV export. */
let db: PGlite;
let app: FastifyInstance;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_B = fixtureId('b', ENTITY.user);

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);

  await recordEvent(db, { orgId: ORG_A, type: 'scanner.created', actorUserId: USER_A });
  await recordEvent(db, {
    orgId: ORG_A,
    type: 'message.received',
    payload: { preview: '=HYPERLINK("http://evil.example","click")' },
  });
  await recordEvent(db, { orgId: ORG_B, type: 'scanner.created', actorUserId: USER_B });

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = (request.headers as Record<string, unknown>)['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /v1/events/actors', () => {
  it('lists the people in the caller s own log, by name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events/actors',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      actors: [{ id: USER_A, name: 'User a', email: 'a@example.test' }],
    });
  });

  it('turns away a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/events/actors' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v1/events.csv', () => {
  it('exports the caller s org only, as a CSV attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events.csv',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-log-\d{8}\.csv"$/,
    );
    expect(response.headers['x-export-truncated']).toBe('false');

    const lines = response.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'date_sast,created_at_utc,type,outcome,actor_kind,actor_user_id,subject_table,subject_id,request_id,payload,id',
    );
    // The fixtures record events of their own, so count against the header, not a constant.
    expect(lines.length - 1).toBe(Number(response.headers['x-export-rows']));
    expect(lines.length - 1).toBeGreaterThanOrEqual(2);
    expect(response.body).not.toContain(USER_B);
  });

  it('reads past the first page of 100, so the export is the whole log', async () => {
    for (let i = 0; i < 150; i += 1) {
      await recordEvent(db, { orgId: ORG_A, type: 'job.ingested' });
    }
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events.csv?type=job.ingested&limit=5&offset=40',
      headers: as(AUTH_A),
    });
    // limit and offset belong to the list view and are ignored by the export.
    expect(response.headers['x-export-rows']).toBe('150');
    const ids = response.body
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(',').at(-1));
    expect(new Set(ids).size).toBe(150);
  });

  it('applies the same filters as the list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/events.csv?type=scanner.created&actor=${USER_A}`,
      headers: as(AUTH_A),
    });
    const lines = response.body.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('scanner.created');
    expect(lines[1]).toContain(USER_A);
  });

  it('refuses a filter it cannot read, and a caller with no session', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/events.csv?type=nope',
      headers: as(AUTH_A),
    });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: '/v1/events.csv' });
    expect(anon.statusCode).toBe(401);
  });

  it('quotes a payload carrying formula text so it stays inside one JSON cell', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events.csv?type=message.received',
      headers: as(AUTH_A),
    });
    // The payload is JSON, so it starts with `{` and is safe; the quoting is what matters.
    expect(response.body).toContain('"{""preview"":""=HYPERLINK(');
  });
});

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=1+1', "'=1+1"],
    ['+27 82 000 0000', "'+27 82 000 0000"],
    ['-5', "'-5"],
    ['@SUM(A1)', "'@SUM(A1)"],
    [null, ''],
    [{ a: 1 }, '"{""a"":1}"'],
  ])('%j becomes %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});

describe('eventsToCsv', () => {
  it('writes the date in SAST as DD/MM/YYYY HH:mm beside the stored UTC time', () => {
    const csv = eventsToCsv([
      {
        id: 'e1',
        org_id: ORG_A,
        actor_user_id: null,
        actor_kind: 'system',
        type: 'job.scored',
        subject_table: null,
        subject_id: null,
        request_id: null,
        outcome: 'ok',
        payload: {},
        created_at: '2026-09-21T22:40:00.000Z',
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      '22/09/2026 00:40,2026-09-21T22:40:00.000Z,job.scored,ok,system,,,,,{},e1',
    );
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('caps an export at a size a browser can take', () => {
    expect(EXPORT_ROW_CAP).toBe(10_000);
  });
});
