import { randomUUID } from 'node:crypto';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-410 acceptance, at the button: "Limit reached blocks action with message". The
 * API reads the plan before it hands work to a worker, so the person is told at once.
 * The plan is test data with a made-up name and limits (no real plan: docs/02 D-12).
 */
const NOW = new Date('2026-09-24T08:00:00Z');
const HOUSE = fixtureId('a', ENTITY.org);
const CUSTOMER = fixtureId('b', ENTITY.org);
const AUTH_HOUSE = fixtureId('a', ENTITY.authUser);
const AUTH_CUSTOMER = fixtureId('b', ENTITY.authUser);
let db: PGlite;
let app: FastifyInstance;
const handed: string[] = [];

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });
const usage = (who: string) => app.inject({ method: 'GET', url: '/v1/usage', headers: as(who) });

async function setUsed(metric: string, used: number) {
  await db.query(
    `insert into usage_counters (org_id, metric, period_start, used) values ($1, $2, '2026-09-01', $3)
     on conflict (org_id, metric, period_start) do update set used = excluded.used`,
    [CUSTOMER, `plan:${metric}`, used],
  );
}

async function unscoredJob(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, currency)
     values ($1, 'freelancer', $2, '{}'::jsonb, 'A job', 'ZAR') returning id`,
    [CUSTOMER, `usage-${randomUUID()}`],
  );
  return rows[0]!.id;
}

async function queuedBid(): Promise<string> {
  const jobId = await unscoredJob();
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status)
     values ($1, $2, 'Thanks.', 100000, 'ZAR', 5, 'queued') returning id`,
    [CUSTOMER, jobId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(HOUSE, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(CUSTOMER, 'b', 'b')) await db.exec(row.sql);
  await db.exec(`update orgs set billing_exempt = false where id = '${CUSTOMER}'`);
  await db.exec(
    `update subscriptions set plan = 'test-plan', status = 'active' where org_id = '${CUSTOMER}'`,
  );
  app = buildServer({
    db,
    now: () => NOW,
    authenticate: (request) => {
      const header = (request.headers as Record<string, unknown>)['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    enqueue: {
      score: async (data) => handed.push(`score:${data.jobId}`),
      draft: async (data) => handed.push(`draft:${data.jobId}`),
      submit: async (data) => handed.push(`submit:${data.proposalId}`),
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /v1/usage', () => {
  it('turns away a request with no session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(401);
  });

  it('shows the house org as exempt, with what it used and no limit', async () => {
    const response = await usage(AUTH_HOUSE);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan: { kind: 'exempt' },
      period: { start: '2026-09-01', resetsOn: '2026-10-01' },
    });
    expect(
      response.json().metrics.map((m: { metric: string; limit: null }) => [m.metric, m.limit]),
    ).toEqual([
      ['jobs_scored', null],
      ['bids_drafted', null],
      ['bids_submitted', null],
    ]);
  });

  it('shows a customer with no published plan why nothing metered runs (D-12)', async () => {
    const body = (await usage(AUTH_CUSTOMER)).json();
    expect(body.plan).toEqual({
      kind: 'none',
      reason: 'no_plans',
      message:
        'No plans are published yet, so metered actions are off for this organisation (docs/02 D-12).',
    });
  });

  it('shows a customer on a plan each count against its limit, in whole per cent', async () => {
    await db.exec(`insert into plans (code, name, limits) values
      ('test-plan', 'Test plan', '{"jobs_scored": 10, "bids_drafted": 3, "bids_submitted": null}')`);
    await setUsed('jobs_scored', 8);
    await setUsed('bids_drafted', 1);
    const body = (await usage(AUTH_CUSTOMER)).json();
    expect(body.plan).toEqual({
      kind: 'plan',
      code: 'test-plan',
      name: 'Test plan',
      status: 'active',
    });
    expect(body.metrics).toEqual([
      { metric: 'jobs_scored', label: 'Jobs scored', used: 8, limit: 10, percent: 80 },
      { metric: 'bids_drafted', label: 'Bids drafted', used: 1, limit: 3, percent: 33 },
      { metric: 'bids_submitted', label: 'Bids sent', used: 0, limit: null, percent: null },
    ]);
  });
});

describe('a limit reached blocks the action with the message', () => {
  it('scoring: 402 with the plan s words, and nothing handed to the worker', async () => {
    await setUsed('jobs_scored', 10);
    const jobId = await unscoredJob();
    for (const url of [`/v1/jobs/${jobId}/score`, `/v1/jobs/${jobId}/queue-bid`]) {
      const response = await app.inject({ method: 'POST', url, headers: as(AUTH_CUSTOMER) });
      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe(
        "The Test plan plan's monthly limit for scoring jobs is reached: 10 of 10 used. It resets on 01/10/2026. Choose a bigger plan in Settings to go on now.",
      );
    }
    expect(handed.filter((h) => h.endsWith(jobId))).toEqual([]);
  });

  it('scoring below the limit goes through', async () => {
    await setUsed('jobs_scored', 9);
    const jobId = await unscoredJob();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/score`,
      headers: as(AUTH_CUSTOMER),
    });
    expect(response.statusCode).toBe(202);
    expect(handed).toContain(`score:${jobId}`);
  });

  it('approving: refused while the plan has no room to send, and the bid stays queued', async () => {
    await db.exec(
      `update plans set limits = '{"jobs_scored": 10, "bids_drafted": 3, "bids_submitted": 0}'`,
    );
    const id = await queuedBid();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${id}/approve`,
      headers: as(AUTH_CUSTOMER),
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().error).toBe(
      'The Test plan plan does not include sending bids. Choose another plan in Settings.',
    );
    const { rows } = await db.query<{ status: string }>(
      'select status from proposals where id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('queued');

    const bulk = await app.inject({
      method: 'POST',
      url: '/v1/proposals/bulk',
      headers: as(AUTH_CUSTOMER),
      payload: { action: 'approve', ids: [id] },
    });
    expect(bulk.json().results).toEqual([
      {
        id,
        ok: false,
        error: 'The Test plan plan does not include sending bids. Choose another plan in Settings.',
      },
    ]);
    expect(handed).not.toContain(`submit:${id}`);
  });

  it('the house org is never stopped', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${fixtureId('a', ENTITY.job)}/score`,
      headers: as(AUTH_HOUSE),
    });
    expect(response.statusCode).toBe(202);
  });
});
