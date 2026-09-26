import { randomUUID } from 'node:crypto';
import type { Queryable } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import {
  apiEnqueue,
  composeWorkers,
  redisConnection,
  type ComposeOptions,
  type WorkerRuntime,
} from '@arbitron/workers';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

/**
 * ARB-510, the owner's audit E-02: "One signed-in slice runs: browser → API → queue →
 * worker → DB event → UI". The API and the workers are composed exactly as their
 * `main.ts` files compose them (`apiEnqueue`, `composeWorkers`), over a real Redis; the
 * database is PGlite and the model is scripted (no key, V-04). A request the web page
 * makes goes in; the worker's event comes out of the route the page reads.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER_AUTH = fixtureId('a', ENTITY.authUser);
const JOB = fixtureId('a', ENTITY.job);
const MODEL = 'claude-opus-5';

let db: PGlite;
let app: FastifyInstance;
let runtime: WorkerRuntime;
const transportCalls: string[] = [];

/** Answers as a model that scores the job `skip`, so the chain stops at the score. */
const transport: NonNullable<ComposeOptions['transport']> = {
  send(request) {
    transportCalls.push(request.model);
    return Promise.resolve({
      text: JSON.stringify({
        score: 21,
        verdict: 'skip',
        reasons: ['The brief is a single line.', 'The budget is below any delivery cost.'],
        flags: [],
        reply_probability: 0.05,
      }),
      model: request.model,
      usage: { inputTokens: 900, outputTokens: 120 },
    });
  },
};

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.query('delete from job_scores where job_id = $1', [JOB]);

  runtime = composeWorkers({
    db: db as unknown as Queryable,
    connection: redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'),
    prefix: `slice-${randomUUID()}`,
    config: {
      liveMode: false,
      llm: { apiKey: 'unused', scoreModel: MODEL, draftModel: MODEL },
      freelancer: null,
      upwork: null,
      off: {},
    },
    transport,
  });
  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    enqueue: apiEnqueue(runtime.queues),
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  for (const queue of Object.values(runtime.queues)) await queue.obliterate({ force: true });
  await runtime.close();
  await db.close();
});

describe('the composed runtime', () => {
  it('consumes every queue a configured process should, and leaves the rest', () => {
    expect([...runtime.running].sort()).toEqual(
      [
        'auto-reply',
        'billing',
        'brief-build',
        'discovery',
        'draft-bid',
        'estimate',
        'inbox-sync',
        'ingest',
        'margin',
        'reprice',
        'retention',
        'score',
        'send-message',
        'sourcing',
        'submit',
      ].sort(),
    );
    expect(runtime.running).not.toContain('notify');
  });

  it('turns the model queues off when there is no model', async () => {
    const without = composeWorkers({
      db: db as unknown as Queryable,
      connection: redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'),
      prefix: `slice-off-${randomUUID()}`,
      config: {
        liveMode: false,
        llm: null,
        freelancer: null,
        upwork: null,
        off: { model: 'ANTHROPIC_API_KEY is not set' },
      },
      transport: null,
    });
    for (const name of ['score', 'estimate', 'draft-bid', 'discovery', 'brief-build'])
      expect(without.running).not.toContain(name);
    expect(without.off).toEqual({ model: 'ANTHROPIC_API_KEY is not set' });
    await without.close();
  });

  it('reports ready when the database and Redis answer', async () => {
    expect(await runtime.ready()).toMatchObject({
      ready: true,
      database: 'ok',
      redis: 'ok',
    });
  });
});

describe('a signed-in request runs through the queue to a worker and back', () => {
  it('Score now: the API queues it, the score worker scores it, the page reads the score', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${JOB}/score`,
      headers: { 'x-test-auth-user': OWNER_AUTH },
    });
    expect(asked.statusCode).toBe(202);

    const event = await until(async () => {
      const { rows } = await db.query<{ outcome: string; request_id: string | null }>(
        `select outcome, request_id from events where type = 'job.scored' and payload->>'jobId' = $1`,
        [JOB],
      );
      return rows[0];
    }, 'the score worker');
    expect(event.outcome).toBe('ok');
    expect(transportCalls).toEqual([MODEL]);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${JOB}`,
      headers: { 'x-test-auth-user': OWNER_AUTH },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ job: { score: 21, verdict: 'skip' } });
  }, 30_000);

  it('Approve: the approval is saved and the submit worker takes it, behind the live gate', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status)
       values ($1, $2, 'A bid for the slice test.', 150000, 'ZAR', 7, 'queued') returning id`,
      [ORG, JOB],
    );
    const proposal = rows[0]!.id;
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/proposals/${proposal}/approve`,
      headers: { 'x-test-auth-user': OWNER_AUTH },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ queued: true });

    const handled = await until(async () => {
      const { rows: events } = await db.query<{ type: string; outcome: string }>(
        `select type, outcome from events
          where subject_id = $1 and type in ('external.blocked_by_live_mode', 'proposal.submitted')
          order by created_at limit 1`,
        [proposal],
      );
      return events[0];
    }, 'the submit worker');
    // Nothing is sent: live mode is off in the environment (D-032).
    expect(handled.outcome).not.toBe('ok');
    const sent = await db.query<{ count: number }>(
      `select count(*)::int as count from events
        where type = 'external.call' and subject_id = $1 and outcome = 'ok'`,
      [proposal],
    );
    expect(sent.rows[0]?.count).toBe(0);
  }, 30_000);
});
