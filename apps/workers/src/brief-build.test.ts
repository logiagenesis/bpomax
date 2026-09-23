import {
  captureDiscoveryAnswers,
  listEvents,
  loadCurrentBrief,
  loadDiscoverySession,
  startDiscoverySession,
} from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBrief } from './brief-build.js';

/** ARB-131: the model structures the answers into version 1; the operator locks it. Scripted model, real Postgres. */
const ORG = fixtureId('a', ENTITY.org);
const JOB = fixtureId('a', ENTITY.job);
const MODEL = 'claude-opus-5';
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let thread: string;

class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async send(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('the script ran out of replies');
    return { text, model: request.model, usage: { inputTokens: 1500, outputTokens: 400 } };
  }
}

const MODEL_BRIEF = {
  outcome: 'A faster Shopify shop that takes orders',
  users: 'The shop’s customers',
  must_haves: ['Checkout', 'Product pages'],
  later: ['Loyalty programme'],
  references: [],
  assets_provided: ['Domain'],
  assets_missing: ['Brand files'],
  tech_constraints: ['Shopify'],
  deadline: '2026-11-30',
  deadline_fixed: false,
  budget: { min: 15000, max: 20000, currency: 'ZAR', type: 'fixed' },
  acceptance_criteria: ['Orders go through'],
  sign_off: { name: 'Thandi', response_time: 'same day' },
  risks: ['Brand files are missing'],
};

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) {
    if (['memberships', 'jobs', 'settings'].includes(row.table)) await db.exec(row.sql);
  }
  await db.query(`update jobs set title = 'Shopify store rebuild' where id = $1`, [JOB]);
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5001', 'acme-shop') returning id`,
    [ORG, JOB],
  );
  thread = t.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('buildBrief', () => {
  it('does nothing without a session, or below the threshold', async () => {
    const transport = new ScriptedTransport([]);
    expect(
      await buildBrief({ db, transport, model: MODEL, now: () => NOW }, { threadId: thread }),
    ).toEqual({ status: 'skipped', reason: 'no_session' });
    const session = await startDiscoverySession(db, { orgId: ORG, threadId: thread });
    await captureDiscoveryAnswers(
      db,
      session,
      { outcome: 'A faster shop', users: 'Customers' },
      'client',
      NOW,
    );
    expect(
      await buildBrief({ db, transport, model: MODEL, now: () => NOW }, { threadId: thread }),
    ).toEqual({ status: 'skipped', reason: 'below_threshold' });
    expect(transport.requests).toHaveLength(0);
  });

  it('at the threshold, drafts version 1 from the model’s structure, validated, with what a lock still needs; never twice', async () => {
    const session = (await loadDiscoverySession(db, thread))!;
    await captureDiscoveryAnswers(
      db,
      session,
      {
        day_one: 'Checkout and product pages; loyalty can wait',
        assets: 'Domain; no brand files',
        deadline: 'End of November, flexible',
        budget: 'R15 000 to R20 000 fixed',
        acceptance: 'Orders go through',
      },
      'client',
      NOW,
    );
    const transport = new ScriptedTransport([JSON.stringify(MODEL_BRIEF)]);
    const run = await buildBrief(
      { db, transport, model: MODEL, now: () => NOW },
      { threadId: thread },
    );
    expect(run).toMatchObject({
      status: 'drafted',
      lockBlockers: ['a service category', 'a delivery route'],
    });
    expect(transport.requests[0]?.prompt).toContain('Today: 2026-09-23');
    expect(transport.requests[0]?.prompt).toContain(
      '- budget (Budget range, and fixed or hourly?): R15 000 to R20 000 fixed',
    );

    const brief = await loadCurrentBrief(db, thread);
    expect(brief).toMatchObject({
      version: 1,
      locked: false,
      title: 'Shopify store rebuild',
      outcome: 'A faster Shopify shop that takes orders',
      must_haves: ['Checkout', 'Product pages'],
      later: ['Loyalty programme'],
      deadline: '2026-11-30',
      deadline_fixed: false,
      // Hand-worked: R15 000 and R20 000 are 1 500 000 and 2 000 000 cents.
      budget_min_minor: '1500000',
      budget_max_minor: '2000000',
      budget_currency: 'ZAR',
      budget_type: 'fixed',
      risks: ['Brand files are missing'],
      category_slug: null,
    });
    const events = await listEvents(db, { type: 'brief.drafted' });
    expect(events[0]?.payload).toMatchObject({
      via: 'model',
      version: 1,
      completeness: 70,
      model_used: true,
    });
    const calls = await db.query<{ purpose: string; outcome: string }>(
      'select purpose::text as purpose, outcome::text as outcome from llm_calls',
    );
    expect(calls.rows).toEqual([{ purpose: 'brief', outcome: 'ok' }]);

    expect(
      await buildBrief(
        { db, transport: new ScriptedTransport([]), model: MODEL },
        { threadId: thread },
      ),
    ).toEqual({ status: 'skipped', reason: 'exists' });
  });

  it('a model that cannot answer in the schema twice is final and recorded, and no brief is written', async () => {
    const other = await db.query<{ id: string }>(
      `insert into threads (org_id, job_id, platform, external_thread_id, client_handle) values ($1, $2, 'freelancer', '5002', 'beta') returning id`,
      [ORG, JOB],
    );
    const session = await startDiscoverySession(db, { orgId: ORG, threadId: other.rows[0]!.id });
    await captureDiscoveryAnswers(
      db,
      session,
      {
        outcome: 'x',
        users: 'x',
        day_one: 'x',
        references: 'x',
        assets: 'x',
        tech: 'x',
        deadline: 'x',
      },
      'client',
      NOW,
    );
    const transport = new ScriptedTransport(['nope', '{"outcome": 5}']);
    await expect(
      buildBrief({ db, transport, model: MODEL, now: () => NOW }, { threadId: other.rows[0]!.id }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await loadCurrentBrief(db, other.rows[0]!.id)).toBeNull();
    const calls = await db.query<{ outcome: string }>(
      `select outcome::text as outcome from llm_calls order by created_at desc limit 1`,
    );
    expect(calls.rows[0]?.outcome).toBe('invalid_output');
  });
});
