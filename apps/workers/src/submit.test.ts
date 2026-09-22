import { randomUUID } from 'node:crypto';
import type { BidPayload } from '@arbitron/core';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';
import { createSubmitProcessor, enqueueSubmit, submitProposal, type BidPlacer } from './submit.js';

/**
 * ARB-044 acceptance, first clause: "With LIVE_MODE=false nothing is sent and the
 * would-send payload is logged". The platform is a scripted client; the second clause,
 * a sandbox submission, waits on the Freelancer client and account (docs/BLOCKERS.md
 * C-02). Every figure here is this file's test data.
 */
const ORG = fixtureId('a', ENTITY.org);
const USER = fixtureId('a', ENTITY.user);
const SCANNER = fixtureId('a', ENTITY.scanner);
const NOW = new Date('2026-09-22T12:00:00Z');
let db: PGlite;

class ScriptedPlacer implements BidPlacer {
  readonly placed: BidPayload[] = [];
  constructor(private readonly behaviour: 'accept' | 'refuse' = 'accept') {}
  placeBid(payload: BidPayload): Promise<{ platformRef: string }> {
    this.placed.push(payload);
    if (this.behaviour === 'refuse') return Promise.reject(new Error('platform said no: 429'));
    return Promise.resolve({ platformRef: `bid-${String(this.placed.length)}` });
  }
}

async function setLive(orgLive: boolean): Promise<void> {
  await db.query(
    `update settings set live_mode = $2, min_margin_pct = 20, min_margin_zar_minor = 50000,
       fx_buffer_pct = 3, retention_days = 365,
       fee_table = '[{"platform":"freelancer","project_type":"fixed","side":"freelancer","percent":10,"source_url":"https://example.test/fees","read_on":"2026-09-22"}]'::jsonb
     where org_id = $1`,
    [ORG, orgLive],
  );
}

async function setAllowance(allowance: number | null): Promise<void> {
  await db.query(
    `update platform_accounts set plan_name = 'Test plan', monthly_bid_allowance = $2
     where org_id = $1 and platform = 'freelancer'`,
    [ORG, allowance],
  );
  await db.query(`delete from usage_counters where org_id = $1 and metric = 'bids:freelancer'`, [
    ORG,
  ]);
}

async function insertJob(key: string, scannerId: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, budget_max_minor, currency, scanner_id)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, 500000, 'ZAR', $4) returning id`,
    [ORG, `${key}-${randomUUID()}`, `Job ${key}`, scannerId],
  );
  return rows[0]!.id;
}

async function insertProposal(
  jobId: string,
  fields: {
    status?: string;
    approvedVia?: 'web' | 'telegram' | 'auto' | null;
    approvedBy?: string | null;
  } = {},
): Promise<string> {
  const status = fields.status ?? 'approved';
  const via = fields.approvedVia === undefined ? 'web' : fields.approvedVia;
  const by = fields.approvedBy === undefined ? USER : fields.approvedBy;
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals
       (org_id, job_id, body, amount_minor, currency, delivery_days, milestones, status, approved_by, approved_via)
     values ($1, $2, 'Thanks for the brief.', 450000, 'ZAR', 7,
             '[{"title":"Design","amount_minor":150000},{"title":"Build","amount_minor":300000}]'::jsonb,
             $3, $4, $5)
     returning id`,
    [
      ORG,
      jobId,
      status,
      status === 'approved' || status === 'submitted' ? by : null,
      status === 'approved' || status === 'submitted' ? via : null,
    ],
  );
  return rows[0]!.id;
}

async function proposalState(id: string) {
  const { rows } = await db.query<{
    status: string;
    platform_ref: string | null;
    submitted_at: string | null;
    failure_reason: string | null;
  }>(
    'select status, platform_ref, submitted_at::text, failure_reason from proposals where id = $1',
    [id],
  );
  return rows[0]!;
}

async function eventsFor(proposalId: string) {
  const { rows } = await db.query<{
    type: string;
    outcome: string;
    payload: Record<string, unknown>;
  }>(`select type, outcome, payload from events where subject_id = $1 order by created_at`, [
    proposalId,
  ]);
  return rows;
}

async function bidsUsed(): Promise<number> {
  const { rows } = await db.query<{ used: number }>(
    `select used from usage_counters where org_id = $1 and metric = 'bids:freelancer' and period_start = '2026-09-01'`,
    [ORG],
  );
  return rows[0]?.used ?? 0;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('with LIVE_MODE off', () => {
  it('sends nothing, keeps the proposal approved, and logs the bid that would have been sent', async () => {
    await setLive(true);
    await setAllowance(50);
    const jobId = await insertJob('dry');
    const proposalId = await insertProposal(jobId);
    const placer = new ScriptedPlacer();
    const requestId = randomUUID();

    const result = await submitProposal(
      { db, liveMode: false, placer, now: () => NOW },
      { proposalId, requestId },
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'live_mode_off' });
    if (result.status === 'blocked')
      expect(result.message).toMatch(/LIVE_MODE is false in this environment/);

    expect(placer.placed).toEqual([]);
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'approved',
      platform_ref: null,
    });
    expect(await bidsUsed()).toBe(0);

    const events = await eventsFor(proposalId);
    expect(events.map((e) => `${e.type}:${e.outcome}`)).toEqual([
      'external.blocked_by_live_mode:blocked',
      'proposal.submitted:blocked',
    ]);
    const job = await db.query<{ external_id: string }>(
      'select external_id from jobs where id = $1',
      [jobId],
    );
    expect(events[0]?.payload).toEqual({
      closedBy: 'environment',
      wouldSend: {
        action: 'place_bid',
        platform: 'freelancer',
        jobExternalId: job.rows[0]!.external_id,
        proposalId,
        amountMinor: 450_000,
        currency: 'ZAR',
        deliveryDays: 7,
        milestones: [
          { title: 'Design', amount_minor: 150_000 },
          { title: 'Build', amount_minor: 300_000 },
        ],
        body: 'Thanks for the brief.',
      },
    });
    expect(events[1]?.payload).toMatchObject({ reason: 'live_mode_off', closedBy: 'environment' });
    const pipeline = await db.query('select 1 from pipeline_items where proposal_id = $1', [
      proposalId,
    ]);
    expect(pipeline.rows).toHaveLength(0);
  });

  it('is also off while the organisation has not switched live mode on, whatever the environment says', async () => {
    await setLive(false);
    const proposalId = await insertProposal(await insertJob('org-off'));
    const placer = new ScriptedPlacer();
    const result = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId },
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'live_mode_off' });
    if (result.status === 'blocked')
      expect(result.message).toMatch(/organisation has not switched live mode on/);
    expect(placer.placed).toEqual([]);
    expect((await eventsFor(proposalId))[0]?.payload).toMatchObject({ closedBy: 'org' });
  });
});

describe('approval', () => {
  it('sends nothing that is not approved, and does not send twice', async () => {
    await setLive(true);
    const placer = new ScriptedPlacer();
    const queued = await insertProposal(await insertJob('queued'), { status: 'queued' });
    expect(await submitProposal({ db, liveMode: true, placer }, { proposalId: queued })).toEqual({
      status: 'skipped',
      reason: 'not_approved',
    });
    expect((await eventsFor(queued))[0]).toMatchObject({
      type: 'proposal.submitted',
      outcome: 'skipped',
    });

    const done = await insertProposal(await insertJob('done'), { status: 'submitted' });
    await db.query(`update proposals set platform_ref = 'bid-earlier' where id = $1`, [done]);
    expect(await submitProposal({ db, liveMode: true, placer }, { proposalId: done })).toEqual({
      status: 'already_submitted',
      platformRef: 'bid-earlier',
    });
    expect(placer.placed).toEqual([]);
    await expect(
      submitProposal({ db, liveMode: true, placer }, { proposalId: randomUUID() }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('live, with a client', () => {
  it('places the bid, marks the proposal submitted, opens the pipeline, and counts the bid', async () => {
    await setLive(true);
    await setAllowance(50);
    const jobId = await insertJob('live');
    const proposalId = await insertProposal(jobId, { approvedVia: 'telegram' });
    const placer = new ScriptedPlacer();
    const requestId = randomUUID();

    const result = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId, requestId },
    );
    expect(result).toMatchObject({ status: 'submitted', platformRef: 'bid-1' });
    expect(placer.placed).toHaveLength(1);
    expect(placer.placed[0]).toMatchObject({
      action: 'place_bid',
      proposalId,
      amountMinor: 450_000,
    });

    expect(await proposalState(proposalId)).toMatchObject({
      status: 'submitted',
      platform_ref: 'bid-1',
    });
    expect(new Date((await proposalState(proposalId)).submitted_at!).toISOString()).toBe(
      NOW.toISOString(),
    );
    const pipeline = await db.query<{ stage: string; value_minor: string; currency: string }>(
      'select stage, value_minor::text, currency from pipeline_items where job_id = $1',
      [jobId],
    );
    expect(pipeline.rows).toEqual([{ stage: 'applied', value_minor: '450000', currency: 'ZAR' }]);
    expect(await bidsUsed()).toBe(1);

    const events = await db.query<{ type: string; outcome: string }>(
      'select type, outcome from events where request_id = $1 order by created_at',
      [requestId],
    );
    expect(events.rows).toEqual([
      { type: 'external.call', outcome: 'ok' },
      { type: 'proposal.submitted', outcome: 'ok' },
      { type: 'pipeline.stage_changed', outcome: 'ok' },
    ]);
  });

  it('is blocked, and sends nothing, without a bid allowance or with it spent', async () => {
    await setLive(true);
    await setAllowance(null);
    const placer = new ScriptedPlacer();
    const unknown = await insertProposal(await insertJob('no-allowance'));
    const first = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId: unknown },
    );
    expect(first).toMatchObject({ status: 'blocked', reason: 'allowance' });
    if (first.status === 'blocked') expect(first.message).toMatch(/T-03/);

    await setAllowance(1);
    const one = await insertProposal(await insertJob('one'));
    expect(
      await submitProposal({ db, liveMode: true, placer, now: () => NOW }, { proposalId: one }),
    ).toMatchObject({ status: 'submitted' });
    const two = await insertProposal(await insertJob('two'));
    const spent = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId: two },
    );
    expect(spent).toMatchObject({ status: 'blocked', reason: 'allowance' });
    if (spent.status === 'blocked') expect(spent.message).toMatch(/1 of 1 bids/);
    expect(placer.placed).toHaveLength(1);
    expect(await proposalState(two)).toMatchObject({ status: 'approved' });
  });

  it('is blocked when live but no platform client exists yet (C-02), and gives the bid back', async () => {
    await setLive(true);
    await setAllowance(5);
    const proposalId = await insertProposal(await insertJob('no-client'));
    const result = await submitProposal({ db, liveMode: true, now: () => NOW }, { proposalId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'no_client' });
    if (result.status === 'blocked') expect(result.message).toMatch(/C-02.*Nothing was sent/);
    expect(await bidsUsed()).toBe(0);
  });

  it('gives the bid back and lets the queue retry when the platform refuses; the last attempt marks it failed', async () => {
    await setLive(true);
    await setAllowance(5);
    const proposalId = await insertProposal(await insertJob('refused'));
    const placer = new ScriptedPlacer('refuse');
    await expect(
      submitProposal(
        { db, liveMode: true, placer, now: () => NOW },
        { proposalId },
        { finalAttempt: false },
      ),
    ).rejects.toThrow(/429/);
    expect(await proposalState(proposalId)).toMatchObject({ status: 'approved' });
    expect(await bidsUsed()).toBe(0);

    const final = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId },
      { finalAttempt: true },
    );
    expect(final).toMatchObject({ status: 'failed' });
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'failed',
      failure_reason: 'platform said no: 429',
    });
    expect(await bidsUsed()).toBe(0);
    const events = await eventsFor(proposalId);
    expect(events.map((e) => `${e.type}:${e.outcome}`)).toEqual([
      'external.call:error',
      'external.call:error',
      'proposal.submitted:error',
    ]);
  });

  it('finishes the bookkeeping of a bid already placed on an earlier attempt, without placing it again', async () => {
    await setLive(true);
    await setAllowance(5);
    const jobId = await insertJob('recover');
    const proposalId = await insertProposal(jobId);
    await db.query(
      `insert into events (org_id, actor_kind, type, subject_table, subject_id, outcome, payload)
       values ($1, 'system', 'external.call', 'proposals', $2, 'ok', '{"platformRef":"bid-earlier"}'::jsonb)`,
      [ORG, proposalId],
    );
    const placer = new ScriptedPlacer();
    const result = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId },
    );
    expect(result).toMatchObject({ status: 'submitted', platformRef: 'bid-earlier' });
    expect(placer.placed).toEqual([]);
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'submitted',
      platform_ref: 'bid-earlier',
    });
  });
});

describe('an automatic approval', () => {
  async function autoScanner(fields: { autoSend?: boolean; cap?: number; minScore?: number } = {}) {
    await db.query(
      `update scanners set auto_send = $2, daily_cap = $3, min_score = $4 where id = $1`,
      [SCANNER, fields.autoSend ?? true, fields.cap ?? 2, fields.minScore ?? 60],
    );
    await db.query(`delete from usage_counters where org_id = $1 and metric = $2`, [
      ORG,
      `auto_send:${SCANNER}`,
    ]);
  }
  async function scoredJob(key: string, score: number, scannerId: string | null = SCANNER) {
    const jobId = await insertJob(key, scannerId);
    await db.query(
      `insert into job_scores (org_id, job_id, score, verdict, model) values ($1, $2, $3, 'go', 'm')`,
      [ORG, jobId, score],
    );
    return jobId;
  }

  it('is held to the scanner s daily cap, and the cap is not spent by a blocked send', async () => {
    await setLive(true);
    await setAllowance(50);
    await autoScanner({ cap: 1 });
    const placer = new ScriptedPlacer();
    const first = await insertProposal(await scoredJob('auto-1', 80), { approvedVia: 'auto' });
    expect(
      await submitProposal({ db, liveMode: true, placer, now: () => NOW }, { proposalId: first }),
    ).toMatchObject({ status: 'submitted' });
    const second = await insertProposal(await scoredJob('auto-2', 80), { approvedVia: 'auto' });
    const capped = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId: second },
    );
    expect(capped).toMatchObject({ status: 'blocked', reason: 'daily_cap_reached' });
    if (capped.status === 'blocked') expect(capped.message).toMatch(/1 of 1 today/);
    expect(placer.placed).toHaveLength(1);

    // A person may still send it: the cap is on automatic sends.
    await db.query(`update proposals set approved_via = 'web' where id = $1`, [second]);
    expect(
      await submitProposal({ db, liveMode: true, placer, now: () => NOW }, { proposalId: second }),
    ).toMatchObject({ status: 'submitted' });
  });

  it('is refused below the scanner s minimum score, when auto-send is off, or with no scanner', async () => {
    await setLive(true);
    await setAllowance(50);
    await autoScanner({ minScore: 70 });
    const placer = new ScriptedPlacer();
    const low = await insertProposal(await scoredJob('auto-low', 65), { approvedVia: 'auto' });
    const lowResult = await submitProposal(
      { db, liveMode: true, placer, now: () => NOW },
      { proposalId: low },
    );
    expect(lowResult).toMatchObject({ status: 'blocked', reason: 'below_min_score' });
    if (lowResult.status === 'blocked')
      expect(lowResult.message).toMatch(/scored 65, below the scanner's minimum of 70/);

    await autoScanner({ autoSend: false, cap: 0 });
    const off = await insertProposal(await scoredJob('auto-off', 90), { approvedVia: 'auto' });
    expect(
      await submitProposal({ db, liveMode: true, placer, now: () => NOW }, { proposalId: off }),
    ).toMatchObject({ status: 'blocked', reason: 'auto_send_off' });

    const orphan = await insertProposal(await scoredJob('auto-orphan', 90, null), {
      approvedVia: 'auto',
    });
    expect(
      await submitProposal({ db, liveMode: true, placer, now: () => NOW }, { proposalId: orphan }),
    ).toMatchObject({ status: 'blocked', reason: 'no_scanner' });
    expect(placer.placed).toEqual([]);
  });

  it('does not spend a cap slot on a send the live gate stops', async () => {
    await setLive(true);
    await autoScanner({ cap: 1 });
    const proposalId = await insertProposal(await scoredJob('auto-dry', 90), {
      approvedVia: 'auto',
    });
    expect(
      await submitProposal({ db, liveMode: false, now: () => NOW }, { proposalId }),
    ).toMatchObject({ status: 'blocked', reason: 'live_mode_off' });
    const { rows } = await db.query<{ used: number }>(
      `select used from usage_counters where org_id = $1 and metric = $2 and period_start = '2026-09-22'`,
      [ORG, `auto_send:${SCANNER}`],
    );
    expect(rows[0]?.used ?? 0).toBe(0);
  });
});

describe('on the queue', () => {
  const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

  it('submits what it is handed, once', async () => {
    await setLive(true);
    await setAllowance(50);
    const prefix = `arb-test-${randomUUID()}`;
    const queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 10 });
    const events = new QueueEvents('submit', { connection, prefix });
    await events.waitUntilReady();
    const placer = new ScriptedPlacer();
    const worker = startWorker(
      'submit',
      createSubmitProcessor({ db, liveMode: true, placer, now: () => NOW }),
      {
        connection,
        prefix,
        deadLetter: queues[DEAD_LETTER_QUEUE],
      },
    );
    try {
      const proposalId = await insertProposal(await insertJob('queued-live'));
      const queued = await enqueueSubmit(queues.submit, { proposalId });
      const again = await enqueueSubmit(queues.submit, { proposalId });
      expect(again.id).toBe(queued.id);
      const result = await queued.waitUntilFinished(events, 10_000);
      expect(result).toMatchObject({ status: 'submitted', platformRef: 'bid-1' });
      expect(placer.placed).toHaveLength(1);
    } finally {
      await worker.close();
      await events.close();
      for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
      await closeQueues(queues);
    }
  }, 30_000);
});
