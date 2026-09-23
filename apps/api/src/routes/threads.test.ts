import { insertBriefVersion, startDiscoverySession, captureDiscoveryAnswers } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-140: the conversations page reads its threads and messages from here. Real
 * Postgres with RLS on: an organisation sees its own threads and no other's.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_NOBODY = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_B = fixtureId('b', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let app: FastifyInstance;
let busy: string;
let quiet: string;
let other: string;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

async function thread(org: string, handle: string, status: string, lastAt: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle, status, last_message_at)
     values ($1, $2, 'freelancer', $3, $4, $5::thread_status, $6) returning id`,
    [org, org === ORG_A ? JOB : null, handle, handle, status, lastAt],
  );
  return rows[0]!.id;
}

async function message(
  org: string,
  threadId: string,
  fields: {
    direction: 'in' | 'out';
    origin?: 'app' | 'platform';
    body: string;
    sentAt?: string | null;
    createdAt: string;
    approvedBy?: string;
    rejectedAt?: string;
    failureReason?: string;
  },
) {
  await db.query(
    `insert into messages (org_id, thread_id, direction, origin, body, sent_at, created_at, approved_by, approved_via, rejected_at, failure_reason, external_message_id)
     values ($1, $2, $3::message_direction, $4, $5, $6, $7, $8, $9::approval_channel, $10, $11, $12)`,
    [
      org,
      threadId,
      fields.direction,
      fields.origin ?? 'app',
      fields.body,
      fields.sentAt ?? null,
      fields.createdAt,
      fields.approvedBy ?? null,
      fields.approvedBy ? 'web' : null,
      fields.rejectedAt ?? null,
      fields.failureReason ?? null,
      fields.direction === 'in' || fields.origin === 'platform' ? `ext-${fields.createdAt}` : null,
    ],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${USER_B}', 'owner')`);
  await db.exec(
    `insert into users (id, auth_user_id, email) values ('${fixtureId('c', ENTITY.user)}', '${AUTH_NOBODY}', 'c@example.test')`,
  );
  await db.query(
    `insert into jobs (id, org_id, platform, external_id, raw, title) values ($1, $2, 'freelancer', '15791512', '{}'::jsonb, 'Shopify store rebuild')`,
    [JOB, ORG_A],
  );
  busy = await thread(ORG_A, 'acme-shop', 'awaiting_operator', '2026-09-23T09:58:00Z');
  quiet = await thread(ORG_A, 'quiet-client', 'open', null);
  other = await thread(ORG_B, 'someone-else', 'open', '2026-09-23T09:00:00Z');

  await message(ORG_A, busy, {
    direction: 'out',
    origin: 'platform',
    body: 'Hello, here is our bid.',
    sentAt: '2026-09-22T08:00:00Z',
    createdAt: '2026-09-22T08:00:00Z',
  });
  await message(ORG_A, busy, {
    direction: 'in',
    origin: 'platform',
    body: 'Hi, can you start on Monday?',
    sentAt: '2026-09-23T09:58:00Z',
    createdAt: '2026-09-23T09:58:30Z',
  });
  await message(ORG_A, busy, {
    direction: 'out',
    body: 'Yes, Monday works.',
    createdAt: '2026-09-23T09:59:00Z',
  });
  await message(ORG_A, busy, {
    direction: 'out',
    body: 'An earlier draft, rejected.',
    createdAt: '2026-09-23T09:58:45Z',
    rejectedAt: '2026-09-23T09:59:30Z',
    failureReason: 'too short',
  });
  await message(ORG_B, other, {
    direction: 'in',
    origin: 'platform',
    body: 'Not yours to read.',
    sentAt: '2026-09-23T09:00:00Z',
    createdAt: '2026-09-23T09:00:00Z',
  });

  const session = await startDiscoverySession(db, { orgId: ORG_A, threadId: busy });
  await captureDiscoveryAnswers(
    db,
    session,
    { outcome: 'An online shop', users: 'Customers', day_one: 'Orders' },
    'client',
    NOW,
  );
  await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: busy,
    brief: {
      title: 'Shopify store rebuild',
      outcome: 'An online shop',
      users: 'Customers',
      mustHaves: ['Orders'],
      later: [],
      references: [],
      assetsProvided: [],
      assetsMissing: [],
      techConstraints: [],
      deadline: null,
      deadlineFixed: null,
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      acceptanceCriteria: [],
      signOff: { name: null, responseTime: null },
      risks: [],
      category: null,
      deliveryRoute: null,
    },
  });

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => NOW,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /v1/threads', () => {
  it('lists the organisation’s threads, most recent message first, with where each stands', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/threads', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    const { threads, page } = response.json();
    expect(page).toEqual({ limit: 50, offset: 0 });
    expect(threads.map((t: { clientHandle: string }) => t.clientHandle)).toEqual([
      'acme-shop',
      'quiet-client',
    ]);
    expect(threads[0]).toMatchObject({
      id: busy,
      platform: 'freelancer',
      jobTitle: 'Shopify store rebuild',
      status: 'awaiting_operator',
      // Hand-counted: two platform messages and two app drafts.
      messageCount: 4,
      // Hand-counted: one draft waits; the rejected one does not.
      pendingReplies: 1,
      lastMessage: { direction: 'out', body: 'Yes, Monday works.' },
      // Hand-worked: 3 of 10 questions answered is 30 %.
      discovery: { completeness: 30 },
      brief: { version: 1, locked: false },
    });
    expect(threads[1]).toMatchObject({
      id: quiet,
      messageCount: 0,
      pendingReplies: 0,
      lastMessage: null,
      discovery: null,
      brief: null,
    });
  });

  it('filters by status and refuses a status that is not one', async () => {
    const open = await app.inject({
      method: 'GET',
      url: '/v1/threads?status=open',
      headers: as(AUTH_A),
    });
    expect(open.json().threads.map((t: { id: string }) => t.id)).toEqual([quiet]);
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/threads?status=busy',
      headers: as(AUTH_A),
    });
    expect(bad.statusCode).toBe(400);
    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/threads?limit=0',
      headers: as(AUTH_A),
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('shows another organisation only its own, and nothing to someone with no membership or no session', async () => {
    const b = await app.inject({ method: 'GET', url: '/v1/threads', headers: as(AUTH_B) });
    expect(b.json().threads.map((t: { id: string }) => t.id)).toEqual([other]);
    const nobody = await app.inject({
      method: 'GET',
      url: '/v1/threads',
      headers: as(AUTH_NOBODY),
    });
    expect(nobody.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'GET', url: '/v1/threads' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('GET /v1/threads/:id', () => {
  it('returns the thread with its messages in the order they happened, each with its state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/threads/${busy}`,
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    const { thread, messages } = response.json();
    expect(thread).toMatchObject({ id: busy, clientHandle: 'acme-shop', messageCount: 4 });
    expect(messages.map((m: { body: string; state: string }) => [m.body, m.state])).toEqual([
      ['Hello, here is our bid.', 'observed'],
      ['Hi, can you start on Monday?', 'received'],
      ['An earlier draft, rejected.', 'rejected'],
      ['Yes, Monday works.', 'queued'],
    ]);
    expect(messages[2]).toMatchObject({ failureReason: 'too short', origin: 'app' });
    expect(messages[1]).toMatchObject({ direction: 'in', externalMessageId: expect.any(String) });
  });

  it('is 404 for another organisation’s thread and 400 for a non-uuid', async () => {
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/threads/${other}`,
      headers: as(AUTH_A),
    });
    expect(hidden.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/v1/threads/nope', headers: as(AUTH_A) });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /v1/service-categories', () => {
  it('lists the seeded categories in their order, for the brief’s category field', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/service-categories',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    const { categories } = response.json();
    expect(categories.length).toBeGreaterThan(0);
    expect(categories[0]).toEqual({
      slug: expect.any(String),
      name: expect.any(String),
      inHouse: expect.any(Boolean),
    });
  });
});
