import { randomUUID } from 'node:crypto';
import { SCORE_SCHEMA, type ModelScore } from '@arbitron/core';
import { SCORING_FIXTURES } from '@arbitron/core/scoring-fixtures';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { Ajv } from 'ajv';
import { QueueEvents, UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';
import { createScoreProcessor, enqueueScore, nanoUsdToCentsCeil, scoreJob } from './score.js';

/**
 * ARB-032 acceptance: "20 fixture jobs scored; schema-valid; red-flag fixtures flagged".
 *
 * The model is a scripted transport (no key: docs/BLOCKERS.md V-04). For the red-flag
 * fixtures the script plays a model that misses every flag and says `go`, so the test
 * proves the flags come from this code, not from a cooperative reply.
 */
const MODEL = 'claude-opus-5';
const ORG = fixtureId('a', ENTITY.org);
let db: PGlite;

class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async send(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('the script ran out of replies');
    return { text, model: request.model, usage: { inputTokens: 1_200, outputTokens: 300 } };
  }
}

const naiveGo: ModelScore = {
  score: 82,
  verdict: 'go',
  reasons: ['Scope is clear enough to price.', 'Budget is in range for the work.'],
  flags: [],
  reply_probability: 0.35,
};

async function insertJob(key: string, job: (typeof SCORING_FIXTURES)[number]['job']) {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs
       (org_id, platform, external_id, raw, title, description, budget_min_minor,
        budget_max_minor, currency, hourly, skills, client_country, client_payment_verified,
        client_spend_minor, client_rating, bid_count, average_bid_minor)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id`,
    [
      ORG,
      `${key}-${randomUUID()}`,
      job.title,
      job.description,
      job.budgetMinMinor,
      job.budgetMaxMinor,
      job.currency,
      job.hourly,
      job.skills,
      job.clientCountry,
      job.clientPaymentVerified,
      job.clientSpendMinor,
      job.clientRating,
      job.bidCount,
      job.averageBidMinor,
    ],
  );
  return rows[0]!.id;
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

describe('scoring the twenty fixtures', () => {
  const validate = new Ajv({ strict: false }).compile(SCORE_SCHEMA);
  const scored = new Map<string, { verdict: string; score: number; flags: string[] }>();

  beforeAll(async () => {
    for (const fixture of SCORING_FIXTURES) {
      const jobId = await insertJob(fixture.key, fixture.job);
      const transport = new ScriptedTransport([JSON.stringify(naiveGo)]);
      const result = await scoreJob({ db, transport, model: MODEL }, { jobId });
      expect(result.status).toBe('scored');
      const { rows } = await db.query<{
        score: number;
        verdict: string;
        reasons: string[];
        flags: string[];
        reply_probability: string;
      }>(
        'select score, verdict, reasons, flags, reply_probability::text from job_scores where job_id = $1',
        [jobId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The stored row, read back, must itself satisfy the schema the model is held to.
      expect(
        validate({
          score: row.score,
          verdict: row.verdict,
          reasons: row.reasons,
          flags: row.flags,
          reply_probability: Number(row.reply_probability),
        }),
        `${fixture.key}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
      scored.set(fixture.key, row);
    }
  }, 60_000);

  it('stores one schema-valid score for every fixture', () => {
    expect(scored.size).toBe(20);
  });

  for (const fixture of SCORING_FIXTURES) {
    if (fixture.ruleFlags.length === 0) {
      it(`${fixture.key}: keeps the model's verdict with no flags`, () => {
        expect(scored.get(fixture.key)).toMatchObject({ verdict: 'go', score: 82, flags: [] });
      });
    } else {
      it(`${fixture.key}: is flagged ${fixture.ruleFlags.join(', ')} although the model missed it`, () => {
        const row = scored.get(fixture.key)!;
        expect(row.flags).toEqual(expect.arrayContaining([...fixture.ruleFlags]));
        expect(row.verdict).not.toBe('go');
      });
    }
  }

  it('turns every scam pattern into a skip', () => {
    for (const key of [
      'flag-paypal-outside',
      'flag-registration-fee',
      'flag-crypto',
      'flag-rent-account',
      'flag-exam',
    ]) {
      expect(scored.get(key)?.verdict, key).toBe('skip');
    }
  });
});

describe('metering and the audit log', () => {
  it('records the call, its cost, and a job.scored event under the same request id', async () => {
    const jobId = await insertJob('metered', SCORING_FIXTURES[0]!.job);
    const requestId = randomUUID();
    const transport = new ScriptedTransport([JSON.stringify(naiveGo)]);
    const result = await scoreJob({ db, transport, model: MODEL }, { jobId, requestId });
    if (result.status !== 'scored') throw new Error('expected a score');

    const calls = await db.query<{ attempts: number; cost_nano_usd: string; outcome: string }>(
      `select attempts, cost_nano_usd::text, outcome from llm_calls where request_id = $1`,
      [requestId],
    );
    expect(calls.rows).toEqual([expect.objectContaining({ attempts: 1, outcome: 'ok' })]);
    const nano = Number(calls.rows[0]!.cost_nano_usd);
    expect(nano).toBeGreaterThan(0);

    const score = await db.query<{ cost_usd_minor: string; input_tokens: number }>(
      'select cost_usd_minor::text, input_tokens from job_scores where id = $1',
      [result.scoreId],
    );
    expect(Number(score.rows[0]!.cost_usd_minor)).toBe(nanoUsdToCentsCeil(nano));
    expect(score.rows[0]!.input_tokens).toBe(1_200);

    const events = await db.query<{ type: string; outcome: string; subject_id: string }>(
      'select type, outcome, subject_id from events where request_id = $1',
      [requestId],
    );
    expect(events.rows).toEqual([
      { type: 'job.scored', outcome: 'ok', subject_id: result.scoreId },
    ]);
  });

  it('asks with thinking on and without any client name or handle in the prompt', async () => {
    const jobId = await insertJob('prompt', SCORING_FIXTURES[1]!.job);
    const transport = new ScriptedTransport([JSON.stringify(naiveGo)]);
    await scoreJob({ db, transport, model: MODEL }, { jobId });
    const request = transport.requests[0]!;
    expect(request.thinking).toBe(true);
    expect(request.model).toBe(MODEL);
    expect(request.prompt).toContain('Shopify theme customisation');
    expect(request.prompt).not.toMatch(/client name|username/i);
  });
});

describe('invalid model output', () => {
  it('is retried once with the problems fed back, and both attempts are charged', async () => {
    const jobId = await insertJob('retry', SCORING_FIXTURES[2]!.job);
    const requestId = randomUUID();
    const transport = new ScriptedTransport([
      'Looks like a solid job, I would bid.',
      JSON.stringify(naiveGo),
    ]);
    const result = await scoreJob({ db, transport, model: MODEL }, { jobId, requestId });
    expect(result.status).toBe('scored');
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.prompt).toContain('Your previous reply was rejected');

    const calls = await db.query<{ attempts: number }>(
      'select attempts from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows[0]!.attempts).toBe(2);
  });

  it('is refused after the retry: no score, an error event, and an unrecoverable failure', async () => {
    const jobId = await insertJob('invalid', SCORING_FIXTURES[3]!.job);
    const requestId = randomUUID();
    const transport = new ScriptedTransport([
      JSON.stringify({ ...naiveGo, score: 140 }),
      JSON.stringify({ ...naiveGo, verdict: 'probably' }),
    ]);
    await expect(
      scoreJob({ db, transport, model: MODEL }, { jobId, requestId }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(transport.requests).toHaveLength(2);

    const scores = await db.query('select 1 from job_scores where job_id = $1', [jobId]);
    expect(scores.rows).toHaveLength(0);
    const calls = await db.query<{ outcome: string; attempts: number; cost_nano_usd: string }>(
      'select outcome, attempts, cost_nano_usd::text from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows[0]).toMatchObject({ outcome: 'invalid_output', attempts: 2 });
    expect(Number(calls.rows[0]!.cost_nano_usd)).toBeGreaterThan(0);
    const events = await db.query<{ outcome: string }>(
      `select outcome from events where request_id = $1 and type = 'job.scored'`,
      [requestId],
    );
    expect(events.rows).toEqual([{ outcome: 'error' }]);
  });
});

describe('idempotency', () => {
  it('does not score, or pay for, the same job twice', async () => {
    const jobId = await insertJob('twice', SCORING_FIXTURES[4]!.job);
    const transport = new ScriptedTransport([JSON.stringify(naiveGo)]);
    const first = await scoreJob({ db, transport, model: MODEL }, { jobId });
    const second = await scoreJob({ db, transport, model: MODEL }, { jobId });
    if (first.status === 'blocked') throw new Error(first.message);
    expect(second).toEqual({ status: 'already_scored', scoreId: first.scoreId });
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses a job that does not exist, without retrying', async () => {
    const transport = new ScriptedTransport([]);
    await expect(
      scoreJob({ db, transport, model: MODEL }, { jobId: randomUUID() }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('on the queue', () => {
  it('sends a job whose output never validates straight to the dead-letter queue', async () => {
    const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const prefix = `arb-test-${randomUUID()}`;
    const queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 10 });
    const events = new QueueEvents('score', { connection, prefix });
    await events.waitUntilReady();
    const transport = new ScriptedTransport(['not json', 'still not json']);
    const worker = startWorker('score', createScoreProcessor({ db, transport, model: MODEL }), {
      connection,
      prefix,
      deadLetter: queues[DEAD_LETTER_QUEUE],
    });
    try {
      const jobId = await insertJob('queued', SCORING_FIXTURES[5]!.job);
      const queued = await enqueueScore(queues.score, { jobId });
      // A second enqueue of the same row is dropped rather than scored again.
      const again = await enqueueScore(queues.score, { jobId });
      expect(again.id).toBe(queued.id);

      await expect(queued.waitUntilFinished(events, 10_000)).rejects.toThrow(/valid JSON/);
      // Two model calls — the first and its one retry — and no queue-level retries.
      expect(transport.requests).toHaveLength(2);
      expect(await queues[DEAD_LETTER_QUEUE].getJob(`score__${queued.id}`)).toBeDefined();
    } finally {
      await worker.close();
      await events.close();
      for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
      await closeQueues(queues);
    }
  });
});
