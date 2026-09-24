import { listEvents } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-061: the routes behind the login, dashboard, feed, approvals and settings pages,
 * against real Postgres with RLS on. Each figure the dashboard shows is hand-worked in
 * a comment beside its assertion (05 section 3.1); each button's route is tried as the
 * owner, as a viewer and from another org.
 */
let db: PGlite;
let app: FastifyInstance;
let bare: FastifyInstance;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const AUTH_OPERATOR = fixtureId('d', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_VIEWER = fixtureId('c', ENTITY.user);
const USER_OPERATOR = fixtureId('d', ENTITY.user);
const JOB_A = fixtureId('a', ENTITY.job);
const JOB_B = fixtureId('b', ENTITY.job);
const PROPOSAL_A = fixtureId('a', ENTITY.proposal);
const MARGIN_A = fixtureId('a', ENTITY.margin);
const ESTIMATE_A = fixtureId('a', ENTITY.estimate);
const PIPELINE_A = fixtureId('a', ENTITY.pipelineItem);
const ACCOUNT_A = fixtureId('a', ENTITY.platformAccount);
const ACCOUNT_B = fixtureId('b', ENTITY.platformAccount);

/** 22/09/2026 12:00 SAST. The month runs from 01/09/2026 00:00 SAST. */
const NOW = new Date('2026-09-22T10:00:00Z');

const JOB_X = fixtureId('e', 70); // won this month, a retainer
const JOB_Y = fixtureId('e', 71); // lost this month
const JOB_Z = fixtureId('e', 72); // scored skip
const JOB_W = fixtureId('e', 73); // scored go, nothing else yet
const JOB_V = fixtureId('e', 74); // margin failed
const JOB_U = fixtureId('e', 75); // never scored, no bid
const PROPOSAL_X = fixtureId('e', 80);
const PROPOSAL_Y = fixtureId('e', 81);
const PROPOSAL_SENT = fixtureId('e', 82);

const enqueue = {
  submit: vi.fn(async () => undefined),
  draft: vi.fn(async () => undefined),
  score: vi.fn(async () => undefined),
};

function as(authUser: string): Record<string, string> {
  return { 'x-test-auth-user': authUser };
}

const FEE_RULE = {
  platform: 'freelancer',
  project_type: 'fixed',
  side: 'freelancer',
  percent: 10,
  min_minor: 500,
  min_currency: 'USD',
  source_url: 'https://www.freelancer.com/feesandcharges',
  read_on: '2026-09-22',
};

async function job(id: string, title: string): Promise<void> {
  await db.exec(`insert into jobs (id, org_id, platform, external_id, raw, title, budget_min_minor, budget_max_minor, currency)
    values ('${id}', '${ORG_A}', 'freelancer', 'ext-${id.slice(-4)}', '{}'::jsonb, '${title}', 100000, 200000, 'ZAR')`);
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);

  await db.exec(`insert into users (id, auth_user_id, email, full_name) values
    ('${USER_VIEWER}', '${AUTH_VIEWER}', 'c@example.test', 'Viewer C'),
    ('${USER_OPERATOR}', '${AUTH_OPERATOR}', 'd@example.test', 'Operator D')`);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_VIEWER}', 'viewer'), ('${ORG_A}', '${USER_OPERATOR}', 'operator')`);

  // The proposal the fixtures give org A is a draft with no margin behind it; make it
  // the bid the approvals page would show: queued, priced from the stored evaluation.
  await db.exec(
    `update margin_evaluations set delivery_estimate_id = '${ESTIMATE_A}' where id = '${MARGIN_A}'`,
  );
  await db.exec(
    `update proposals set status = 'queued', margin_evaluation_id = '${MARGIN_A}' where id = '${PROPOSAL_A}'`,
  );

  // Dashboard rows. Payments: in R3 000,00 and USD 50,00 converted to R900,00 this
  // month; out R1 200,00 this month; USD 100,00 in with no rand figure; R9 999,99 in last
  // month (excluded).
  await db.exec(`insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, paid_at, amount_zar_minor, fx_rate_used, fx_rate_at) values
    ('${ORG_A}', '${PIPELINE_A}', 'in', 'client', 300000, 'ZAR', '2026-09-05T08:00:00Z', null, null, null),
    ('${ORG_A}', '${PIPELINE_A}', 'in', 'client', 5000, 'USD', '2026-09-06T08:00:00Z', 90000, 18.00000000, '2026-09-06T08:00:00Z'),
    ('${ORG_A}', '${PIPELINE_A}', 'out', 'platform_fee', 120000, 'ZAR', '2026-09-10T08:00:00Z', null, null, null),
    ('${ORG_A}', '${PIPELINE_A}', 'in', 'client', 10000, 'USD', '2026-09-11T08:00:00Z', null, null, null),
    ('${ORG_A}', '${PIPELINE_A}', 'in', 'client', 999999, 'ZAR', '2026-08-30T08:00:00Z', null, null, null)`);
  await db.exec(
    `update pipeline_items set value_minor = 200000, currency = 'ZAR' where id = '${PIPELINE_A}'`,
  );

  await job(JOB_X, 'Won retainer');
  await job(JOB_Y, 'Lost one');
  await job(JOB_Z, 'Scam');
  await job(JOB_W, 'Fresh go');
  await job(JOB_V, 'Thin margin');
  await job(JOB_U, 'Untouched');
  // The fixture message was written at the database's own clock; the dashboard month is NOW's.
  await db.exec(
    `update messages set created_at = '2026-09-05T08:00:00Z' where org_id = '${ORG_A}'`,
  );
  await db.exec(`insert into pipeline_items (org_id, job_id, stage, value_minor, currency, retainer, retainer_monthly_minor, stage_changed_at) values
    ('${ORG_A}', '${JOB_X}', 'won', 400000, 'ZAR', true, 50000, '2026-09-15T08:00:00Z'),
    ('${ORG_A}', '${JOB_Y}', 'lost', 100000, 'ZAR', false, null, '2026-09-16T08:00:00Z')`);
  await db.exec(`insert into job_scores (org_id, job_id, score, verdict, model) values
    ('${ORG_A}', '${JOB_Z}', 10, 'skip', 'test'),
    ('${ORG_A}', '${JOB_W}', 80, 'go', 'test'),
    ('${ORG_A}', '${JOB_V}', 75, 'go', 'test')`);
  await db.exec(`insert into margin_evaluations (org_id, job_id, currency, client_budget_minor, platform_fee_minor, supplier_cost_minor, fx_buffer_minor, margin_minor, margin_pct, min_margin_pct, min_margin_zar_minor, passed, reason)
    values ('${ORG_A}', '${JOB_V}', 'ZAR', 200000, 20000, 170000, 0, 10000, 5.000, 30.000, 50000, false, 'margin 5,0% is below the minimum 30,0%')`);
  await db.exec(`insert into proposals (id, org_id, job_id, body, amount_minor, currency, delivery_days, status) values
    ('${PROPOSAL_X}', '${ORG_A}', '${JOB_X}', 'Bid X', 400000, 'ZAR', 10, 'queued'),
    ('${PROPOSAL_Y}', '${ORG_A}', '${JOB_Y}', 'Bid Y', 100000, 'ZAR', 5, 'queued')`);
  await db.exec(`insert into proposals (id, org_id, job_id, body, amount_minor, currency, delivery_days, status, approved_by, approved_via, submitted_at) values
    ('${PROPOSAL_SENT}', '${ORG_A}', '${JOB_W}', 'Sent bid', 150000, 'ZAR', 5, 'submitted', '${USER_A}', 'web', '2026-09-20T08:00:00Z')`);

  const authenticate = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers['x-test-auth-user'];
    return typeof header === 'string' ? header : null;
  };
  app = buildServer({ db, authenticate, enqueue, now: () => NOW, liveMode: false });
  bare = buildServer({ db, authenticate, now: () => NOW });
  await app.ready();
  await bare.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await bare.close();
  await db.close();
});

describe('GET /v1/me and POST /v1/sessions', () => {
  it('names the person, their org and their role', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: USER_A, email: 'a@example.test', fullName: 'User a', telegramLinked: true },
      org: { id: ORG_A, name: 'Org a', baseCurrency: 'ZAR' },
      role: 'owner',
    });
    const viewer = await app.inject({ method: 'GET', url: '/v1/me', headers: as(AUTH_VIEWER) });
    expect(viewer.json()).toMatchObject({ role: 'viewer', user: { telegramLinked: false } });
  });

  it('answers 401 unsigned and 403 for an identity with no membership', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const stranger = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: as('99999999-0000-4000-8000-000000000003'),
    });
    expect(stranger.statusCode).toBe(403);
  });

  it('records a sign-in for someone who may write events, and not for a viewer', async () => {
    const owner = await app.inject({ method: 'POST', url: '/v1/sessions', headers: as(AUTH_A) });
    expect(owner.statusCode).toBe(201);
    expect(owner.json()).toMatchObject({ role: 'owner' });
    const events = await listEvents(db, { type: 'auth.signed_in' });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_user_id).toBe(USER_A);

    const viewer = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(201);
    expect(await listEvents(db, { type: 'auth.signed_in' })).toHaveLength(1);
  });
});

describe('GET /v1/dashboard', () => {
  it('sums the month to date in rand and counts what it cannot convert', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.period).toEqual({ start: '2026-08-31T22:00:00.000Z', end: NOW.toISOString() });
    // In: 300 000 (ZAR) + 90 000 (the rand figure stored with the USD 50,00 payment)
    // = 390 000. The USD 100,00 with no rand figure is not summed; last month's is not
    // in the period.
    expect(body.revenueInZarMinor).toBe('390000');
    // Out: 120 000.
    expect(body.revenueOutZarMinor).toBe('120000');
    // Margin: 390 000 − 120 000 = 270 000.
    expect(body.realisedMarginZarMinor).toBe('270000');
    expect(body.unconverted).toEqual([
      { direction: 'in', currency: 'USD', amountMinor: '10000', count: 1 },
    ]);
    // Open pipeline: the fixture item (applied, 200 000) + the won one (400 000)
    // = 600 000; the lost one is closed.
    expect(body.pipeline).toEqual([{ currency: 'ZAR', amountMinor: '600000', count: 2 }]);
    // One message came in (the fixture's), created now.
    expect(body.replies).toBe(1);
    // Queued: A, X, Y. Submitted this month: the sent one (20/09).
    expect(body.bids).toEqual({ queued: 3, submitted: 1, won: 1, lost: 1 });
    // 1 won ÷ (1 won + 1 lost) = 0,5.
    expect(body.winRate).toBe(0.5);
    expect(body.retainers).toEqual([{ currency: 'ZAR', amountMinor: '50000', count: 1 }]);
  });

  it('shows another org nothing of this one', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: as(AUTH_B) });
    const body = response.json();
    expect(body.revenueInZarMinor).toBe('0');
    expect(body.pipeline).toEqual([]);
    expect(body.bids.queued).toBe(0);
    expect(body.winRate).toBeNull();
  });
});

describe('GET /v1/jobs', () => {
  it('lists the org’s jobs with the latest score, estimate, margin and bid beside each', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/jobs?verdict=go',
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(200);
    const { jobs } = response.json() as { jobs: Record<string, unknown>[] };
    const a = jobs.find((row) => row.id === JOB_A);
    expect(a).toMatchObject({
      title: 'A job',
      score: 70,
      verdict: 'go',
      estimate_expected_minor: '150000',
      estimate_method: 'rate_card',
      margin_minor: '75000',
      margin_pct: '37.500',
      margin_passed: true,
      proposal_id: PROPOSAL_A,
      proposal_status: 'queued',
    });
    expect(jobs.map((row) => row.verdict)).toEqual(['go', 'go', 'go']);
  });

  it('filters the unscored, refuses an unknown verdict, and pages', async () => {
    const unscored = await app.inject({
      method: 'GET',
      url: '/v1/jobs?verdict=unscored',
      headers: as(AUTH_A),
    });
    expect((unscored.json() as { jobs: unknown[] }).jobs).toHaveLength(3);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/jobs?verdict=maybe', headers: as(AUTH_A) }))
        .statusCode,
    ).toBe(400);
    const page = await app.inject({
      method: 'GET',
      url: '/v1/jobs?limit=2&offset=4',
      headers: as(AUTH_A),
    });
    expect((page.json() as { jobs: unknown[] }).jobs).toHaveLength(2);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/jobs?limit=0', headers: as(AUTH_A) }))
        .statusCode,
    ).toBe(400);
  });

  it('shows another org only its own jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/jobs', headers: as(AUTH_B) });
    expect((response.json() as { jobs: { id: string }[] }).jobs.map((row) => row.id)).toEqual([
      JOB_B,
    ]);
  });
});

describe('POST /v1/jobs/:id/queue-bid', () => {
  it('refuses while a bid is already queued, approved or sent', async () => {
    const queued = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_A}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(queued.statusCode).toBe(409);
    expect(queued.json().error).toMatch(/already waiting for approval/);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_W}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toMatch(/already been sent/);
    expect(enqueue.draft).not.toHaveBeenCalled();
  });

  it('drafts from the passed margin once the old bid is out of the way, and logs who asked', async () => {
    await db.exec(`update proposals set status = 'rejected' where id = '${PROPOSAL_A}'`);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_A}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: 'drafting', jobId: JOB_A });
    expect(enqueue.draft).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_A, marginEvaluationId: MARGIN_A }),
    );
    const events = await listEvents(db, { type: 'proposal.draft_requested' });
    expect(events[0]).toMatchObject({ actor_user_id: USER_A, subject_id: JOB_A });
    expect(events[0]?.payload).toMatchObject({ action: 'drafting', via: 'web' });
    await db.exec(`update proposals set status = 'queued' where id = '${PROPOSAL_A}'`);
  });

  it('scores a job nobody has looked at yet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_U}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: 'scoring', jobId: JOB_U });
    expect(enqueue.score).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_U }));
  });

  it('says why it will not draft: scored skip, margin failed, or still in progress', async () => {
    const skip = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_Z}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(skip.statusCode).toBe(422);
    expect(skip.json().error).toMatch(/scored skip/);
    const failed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_V}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error).toContain('margin 5,0% is below the minimum 30,0%');
    await db.exec(`update proposals set status = 'rejected' where id = '${PROPOSAL_SENT}'`);
    const inProgress = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_W}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.json().error).toMatch(/still being worked out/);
    await db.exec(`update proposals set status = 'submitted' where id = '${PROPOSAL_SENT}'`);
  });

  it('refuses an Upwork job: bids go through Upwork itself', async () => {
    await db.exec(`update jobs set platform = 'upwork' where id = '${JOB_U}'`);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_U}/queue-bid`,
      headers: as(AUTH_A),
    });
    await db.exec(`update jobs set platform = 'freelancer' where id = '${JOB_U}'`);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe(
      'Upwork jobs are read only here: bid on Upwork itself (docs/01 section B).',
    );
  });

  it('refuses a viewer, another org, and a server with no queue', async () => {
    enqueue.draft.mockClear();
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_U}/queue-bid`,
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(403);
    const other = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_A}/queue-bid`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
    await db.exec(`update proposals set status = 'rejected' where id = '${PROPOSAL_A}'`);
    const noQueue = await bare.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_A}/queue-bid`,
      headers: as(AUTH_A),
    });
    expect(noQueue.statusCode).toBe(503);
    await db.exec(`update proposals set status = 'queued' where id = '${PROPOSAL_A}'`);
    expect(enqueue.draft).not.toHaveBeenCalled();
    // A refusal leaves no request in the log.
    expect(await listEvents(db, { type: 'proposal.draft_requested' })).toHaveLength(2);
  });
});

describe('proposals', () => {
  it('lists the queue with the figures the card shows, from stored rows', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/proposals', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    const { proposals, biddingPaused } = response.json() as {
      proposals: Record<string, unknown>[];
      biddingPaused: boolean;
    };
    expect(biddingPaused).toBe(false);
    expect(proposals.map((row) => row.status)).toEqual(['queued', 'queued', 'queued']);
    const a = proposals.find((row) => row.id === PROPOSAL_A);
    expect(a).toMatchObject({
      job_title: 'A job',
      amount_minor: '200000',
      currency: 'ZAR',
      delivery_days: 7,
      score: 70,
      estimate_expected_minor: '150000',
      estimate_method: 'rate_card',
      margin_minor: '75000',
      margin_pct: '37.500',
    });
    const all = await app.inject({
      method: 'GET',
      url: '/v1/proposals?status=all',
      headers: as(AUTH_A),
    });
    expect((all.json() as { proposals: unknown[] }).proposals).toHaveLength(4);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/proposals?status=nope', headers: as(AUTH_A) }))
        .statusCode,
    ).toBe(400);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/proposals?status=all',
      headers: as(AUTH_B),
    });
    expect(
      (other.json() as { proposals: { id: string }[] }).proposals.map((row) => row.id),
    ).toEqual([fixtureId('b', ENTITY.proposal)]);
  });

  it('approves as the signed-in person and hands the bid to the submit worker', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_A}/approve`,
      headers: as(AUTH_OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    const { proposal, queued } = response.json();
    expect(proposal).toMatchObject({
      status: 'approved',
      approved_by: USER_OPERATOR,
      approved_by_name: 'Operator D',
      approved_via: 'web',
    });
    expect(queued).toBe(true);
    expect(enqueue.submit).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_A }),
    );
    const events = await listEvents(db, { type: 'proposal.approved' });
    expect(events[0]).toMatchObject({ actor_user_id: USER_OPERATOR, subject_id: PROPOSAL_A });

    const again = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_A}/approve`,
      headers: as(AUTH_A),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('This bid is already approved.');
  });

  it('refuses a viewer and another org, touching nothing', async () => {
    enqueue.submit.mockClear();
    const viewer = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_X}/approve`,
      headers: as(AUTH_VIEWER),
    });
    expect(viewer.statusCode).toBe(403);
    const other = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_X}/approve`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
    const { rows } = await db.query<{ status: string }>(
      `select status from proposals where id = $1`,
      [PROPOSAL_X],
    );
    expect(rows[0]?.status).toBe('queued');
    expect(enqueue.submit).not.toHaveBeenCalled();
  });

  it('an edit puts the bid back in the queue with its approval cleared', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/proposals/${PROPOSAL_A}`,
      headers: as(AUTH_A),
      payload: { body: '  Better words.  ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().proposal).toMatchObject({
      status: 'queued',
      body: 'Better words.',
      approved_by: null,
      approved_via: null,
    });
    const events = await listEvents(db, { type: 'proposal.edited' });
    expect(events[0]?.payload).toMatchObject({ via: 'web', status_before: 'approved' });

    const blank = await app.inject({
      method: 'PATCH',
      url: `/v1/proposals/${PROPOSAL_A}`,
      headers: as(AUTH_A),
      payload: { body: ' ' },
    });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().errors).toEqual([{ field: 'body', message: 'must not be blank' }]);
    const sent = await app.inject({
      method: 'PATCH',
      url: `/v1/proposals/${PROPOSAL_SENT}`,
      headers: as(AUTH_A),
      payload: { body: 'Too late' },
    });
    expect(sent.statusCode).toBe(409);
  });

  it('a rejection records its reason on the bid and in the log', async () => {
    const noReason = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_A}/reject`,
      headers: as(AUTH_A),
      payload: {},
    });
    expect(noReason.statusCode).toBe(422);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_A}/reject`,
      headers: as(AUTH_A),
      payload: { reason: 'Budget too low for the scope' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().proposal).toMatchObject({
      status: 'rejected',
      failure_reason: 'Budget too low for the scope',
    });
    const events = await listEvents(db, { type: 'proposal.rejected' });
    expect(events[0]?.payload).toMatchObject({
      reason: 'Budget too low for the scope',
      via: 'web',
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${PROPOSAL_A}/reject`,
      headers: as(AUTH_A),
      payload: { reason: 'x' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('bulk approves one by one and reports each outcome', async () => {
    enqueue.submit.mockClear();
    const missing = 'ffffffff-0000-4000-8000-000000000099';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/proposals/bulk',
      headers: as(AUTH_A),
      payload: { action: 'approve', ids: [PROPOSAL_X, missing, PROPOSAL_Y] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { id: PROPOSAL_X, ok: true },
      { id: missing, ok: false, error: 'no such bid' },
      { id: PROPOSAL_Y, ok: true },
    ]);
    expect(enqueue.submit).toHaveBeenCalledTimes(2);
    const { rows } = await db.query<{ approved_by: string }>(
      `select approved_by from proposals where id in ($1, $2)`,
      [PROPOSAL_X, PROPOSAL_Y],
    );
    expect(rows.map((row) => row.approved_by)).toEqual([USER_A, USER_A]);

    const noReason = await app.inject({
      method: 'POST',
      url: '/v1/proposals/bulk',
      headers: as(AUTH_A),
      payload: { action: 'reject', ids: [PROPOSAL_X] },
    });
    expect(noReason.statusCode).toBe(422);
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/proposals/bulk',
      headers: as(AUTH_A),
      payload: { action: 'reject', ids: [PROPOSAL_X], reason: 'Changed our minds' },
    });
    expect(rejected.json().results).toEqual([{ id: PROPOSAL_X, ok: true }]);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/proposals/bulk',
      headers: as(AUTH_A),
      payload: { action: 'delete', ids: [] },
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe('settings', () => {
  it('reads the org’s settings, what still blocks live mode, and its accounts', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/settings', headers: as(AUTH_A) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings).toMatchObject({
      minMarginPct: null,
      minMarginZarMinor: null,
      fxBufferPct: null,
      vatPct: '15.000',
      retentionDays: null,
      feeTable: [],
      liveMode: false,
      biddingPaused: false,
    });
    expect(body.liveModeBlockers).toHaveLength(5);
    expect(body.environmentLiveMode).toBe(false);
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: ACCOUNT_A,
        platform: 'freelancer',
        planName: null,
        monthlyBidAllowance: null,
      }),
    ]);
    expect(body.telegramLinked).toBe(true);
    expect(body.role).toBe('owner');
    // The token columns are never sent.
    expect(JSON.stringify(body)).not.toMatch(/token/);
  });

  it('refuses to go live while a rule is missing, naming each one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/settings/live-mode',
      headers: as(AUTH_A),
      payload: { live: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('minimum margin % (docs/02 D-02)');
    expect(response.json().error).toContain('the retention period (docs/02 T-06)');
    expect(await listEvents(db, { type: 'live_mode.changed' })).toHaveLength(0);
  });

  it('saves the margin rules and the fee table, with the change logged', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: as(AUTH_A),
      payload: {
        minMarginPct: '25',
        minMarginZarMinor: 150000,
        fxBufferPct: 3.5,
        retentionDays: 365,
        feeTable: [FEE_RULE],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({
      minMarginPct: '25.000',
      minMarginZarMinor: '150000',
      fxBufferPct: '3.500',
      retentionDays: 365,
      feeTable: [FEE_RULE],
    });
    expect(response.json().liveModeBlockers).toEqual([]);
    const events = await listEvents(db, { type: 'settings.changed' });
    expect(events[0]).toMatchObject({ subject_table: 'settings', actor_user_id: USER_A });
    expect(events[0]?.payload).toMatchObject({
      changed: ['minMarginPct', 'minMarginZarMinor', 'fxBufferPct', 'retentionDays', 'feeTable'],
    });
  });

  it('refuses bad rules field by field, and an operator altogether', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: as(AUTH_A),
      payload: { minMarginPct: -1, feeTable: [{ ...FEE_RULE, source_url: '' }] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.map((error: { field: string }) => error.field)).toEqual([
      'minMarginPct',
      'feeTable[0].source_url',
    ]);
    const operator = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: as(AUTH_OPERATOR),
      payload: { fxBufferPct: 1 },
    });
    expect(operator.statusCode).toBe(403);
    const { rows } = await db.query<{ fx_buffer_pct: string }>(
      `select fx_buffer_pct::text from settings where org_id = $1`,
      [ORG_A],
    );
    expect(rows[0]?.fx_buffer_pct).toBe('3.500');
  });

  it('switches live mode once every rule is set, by an owner only, and logs it', async () => {
    const operator = await app.inject({
      method: 'POST',
      url: '/v1/settings/live-mode',
      headers: as(AUTH_OPERATOR),
      payload: { live: true },
    });
    expect(operator.statusCode).toBe(403);
    const on = await app.inject({
      method: 'POST',
      url: '/v1/settings/live-mode',
      headers: as(AUTH_A),
      payload: { live: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().settings.liveMode).toBe(true);
    const off = await app.inject({
      method: 'POST',
      url: '/v1/settings/live-mode',
      headers: as(AUTH_A),
      payload: { live: false },
    });
    expect(off.json().settings.liveMode).toBe(false);
    const events = await listEvents(db, { type: 'live_mode.changed' });
    expect(events.map((event) => event.payload)).toEqual([
      { via: 'web', live_before: true, live_after: false },
      { via: 'web', live_before: false, live_after: true },
    ]);
    expect(events[0]?.actor_user_id).toBe(USER_A);
    const notBoolean = await app.inject({
      method: 'POST',
      url: '/v1/settings/live-mode',
      headers: as(AUTH_A),
      payload: { live: 'yes' },
    });
    expect(notBoolean.statusCode).toBe(422);
  });

  it('records the plan and allowance on an account, dated in South African time', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/platform-accounts/${ACCOUNT_A}`,
      headers: as(AUTH_A),
      payload: { planName: ' Plus ', monthlyBidAllowance: '100' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().account).toMatchObject({
      planName: 'Plus',
      monthlyBidAllowance: 100,
      planRecordedOn: '2026-09-22',
    });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/platform-accounts/${ACCOUNT_A}`,
      headers: as(AUTH_A),
      payload: { monthlyBidAllowance: 1.5 },
    });
    expect(bad.statusCode).toBe(422);
    const other = await app.inject({
      method: 'PATCH',
      url: `/v1/platform-accounts/${ACCOUNT_B}`,
      headers: as(AUTH_A),
      payload: { planName: 'x' },
    });
    expect(other.statusCode).toBe(404);
    const viewer = await app.inject({
      method: 'PATCH',
      url: `/v1/platform-accounts/${ACCOUNT_A}`,
      headers: as(AUTH_VIEWER),
      payload: { planName: 'x' },
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('the routes the MCP tools add (ARB-330)', () => {
  it('GET /v1/jobs/:id gives one job with its latest estimate in full, to its own org only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${JOB_A}`,
      headers: as(AUTH_VIEWER),
    });
    expect(response.statusCode).toBe(200);
    // The fixture estimate: rate card, R1 000,00 / R1 500,00 / R2 000,00.
    expect(response.json()).toMatchObject({
      job: { id: JOB_A, margin_passed: true },
      estimate: {
        method: 'rate_card',
        currency: 'ZAR',
        lowMinor: '100000',
        expectedMinor: '150000',
        highMinor: '200000',
        turnaroundDays: null,
      },
    });
    const none = await app.inject({ method: 'GET', url: `/v1/jobs/${JOB_U}`, headers: as(AUTH_A) });
    expect(none.json()).toMatchObject({ job: { id: JOB_U }, estimate: null });
    const other = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${JOB_A}`,
      headers: as(AUTH_B),
    });
    expect(other.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/v1/jobs/nope', headers: as(AUTH_A) });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /v1/jobs/:id/score asks for a score, and refuses a viewer, another org and no queue', async () => {
    enqueue.score.mockClear();
    const ok = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB_U}/score`,
      headers: as(AUTH_OPERATOR),
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ action: 'scoring', jobId: JOB_U });
    expect(enqueue.score).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_U }));
    const logged = await listEvents(db, { type: 'job.score_requested' });
    expect(logged[0]).toMatchObject({
      actor_user_id: USER_OPERATOR,
      subject_id: JOB_U,
      payload: { via: 'web' },
    });
    // All at once: each request runs as its own user (withUser under concurrency).
    const refusals = (
      await Promise.all([
        app.inject({ method: 'POST', url: `/v1/jobs/${JOB_U}/score`, headers: as(AUTH_VIEWER) }),
        app.inject({ method: 'POST', url: `/v1/jobs/${JOB_U}/score`, headers: as(AUTH_B) }),
        bare.inject({ method: 'POST', url: `/v1/jobs/${JOB_U}/score`, headers: as(AUTH_A) }),
      ])
    ).map((r) => r.statusCode);
    expect(refusals).toEqual([403, 404, 503]);
    expect(enqueue.score).toHaveBeenCalledTimes(1);
    expect(await listEvents(db, { type: 'job.score_requested' })).toHaveLength(1);
  });

  it('POST /v1/proposals/:id/submit hands only an approved bid back, and only for an approver', async () => {
    const bid = async (status: string): Promise<string> => {
      const { rows } = await db.query<{ id: string }>(
        `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status, approved_by, approved_via, submitted_at)
         values ($1, $2, 'Bid', 100000, 'ZAR', 5, $3::proposal_status,
                 case when $3 in ('approved', 'submitted') then $4::uuid end,
                 case when $3 in ('approved', 'submitted') then 'web'::approval_channel end,
                 case when $3 = 'submitted' then now() end)
         returning id`,
        [ORG_A, JOB_U, status, USER_A],
      );
      return rows[0]!.id;
    };
    const post = (id: string, who: string, server = app) =>
      server.inject({ method: 'POST', url: `/v1/proposals/${id}/submit`, headers: as(who) });
    enqueue.submit.mockClear();

    const approved = await bid('approved');
    const ok = await post(approved, AUTH_A);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ queued: true });
    expect(enqueue.submit).toHaveBeenCalledWith(expect.objectContaining({ proposalId: approved }));
    expect((await listEvents(db, { type: 'proposal.submit_requested' }))[0]).toMatchObject({
      actor_user_id: USER_A,
      subject_id: approved,
      payload: { via: 'web' },
    });

    const cases: [string, number, string][] = [
      [await bid('queued'), 409, 'This bid is waiting for approval. Approve it first.'],
      [await bid('submitted'), 409, 'This bid has already been sent.'],
      [await bid('rejected'), 409, 'This bid is rejected, so it is not sent.'],
    ];
    for (const [id, status, error] of cases) {
      const response = await post(id, AUTH_A);
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toBe(error);
    }
    expect((await post(approved, AUTH_VIEWER)).statusCode).toBe(403);
    expect((await post(approved, AUTH_B)).statusCode).toBe(404);
    expect((await post(approved, AUTH_A, bare)).statusCode).toBe(503);
    expect(enqueue.submit).toHaveBeenCalledTimes(1);
  });
});
