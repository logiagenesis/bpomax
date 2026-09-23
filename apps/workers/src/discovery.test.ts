import { DISCOVERY_QUESTIONS } from '@arbitron/core';
import { listEvents, loadDiscoverySession, startDiscoverySession } from '@arbitron/db';
import { ENTITY, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDiscovery } from './discovery.js';

/**
 * ARB-130 acceptance: "Completeness updates as answers are captured; questions never
 * sent all at once". The model is a scripted transport (docs/BLOCKERS.md V-04); the
 * rows are real Postgres (PGlite).
 */
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
    return { text, model: request.model, usage: { inputTokens: 900, outputTokens: 120 } };
  }
}

async function inbound(body: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
     values ($1, $2, 'in', $3, '2026-09-23T09:58:00Z', 'ext-' || gen_random_uuid()::text, 'platform') returning id`,
    [ORG, thread, body],
  );
  return rows[0]!.id;
}

const drafts = async () =>
  (
    await db.query<{
      id: string;
      body: string;
      approved_by: string | null;
      sent_at: string | null;
    }>(
      `select id, body, approved_by, sent_at from messages
        where thread_id = $1 and direction = 'out' and origin = 'app' order by created_at`,
      [thread],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) {
    if (['memberships', 'jobs', 'settings'].includes(row.table)) await db.exec(row.sql);
  }
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle, status)
     values ($1, $2, 'freelancer', '5001', 'acme-shop', 'awaiting_operator') returning id`,
    [ORG, JOB],
  );
  thread = t.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('a client reply with no session', () => {
  it('is left alone: the operator starts discovery', async () => {
    const id = await inbound('Hi, can you start on Monday?');
    const transport = new ScriptedTransport([]);
    expect(
      await runDiscovery({ db, transport, model: MODEL, now: () => NOW }, { messageId: id }),
    ).toEqual({
      status: 'skipped',
      reason: 'no_session',
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('a client reply with a session', () => {
  it('reads the confident answers, updates completeness, and drafts the next three questions for approval', async () => {
    const session = await startDiscoverySession(db, { orgId: ORG, threadId: thread });
    expect(Number(session.completeness)).toBe(0);
    const id = await inbound(
      'We need an online shop for our customers. Day one it must take orders; the loyalty bit can wait.',
    );
    const transport = new ScriptedTransport([
      JSON.stringify({
        answers: [
          { key: 'outcome', answer: 'An online shop', confidence: 0.95 },
          { key: 'users', answer: 'Their customers', confidence: 0.9 },
          { key: 'day_one', answer: 'Take orders; loyalty can wait', confidence: 0.85 },
          { key: 'budget', answer: 'Probably small', confidence: 0.3 },
        ],
      }),
    ]);
    const run = await runDiscovery(
      { db, transport, model: MODEL, now: () => NOW },
      { messageId: id },
    );
    expect(run).toMatchObject({
      status: 'updated',
      captured: ['outcome', 'users', 'day_one'],
      // Hand-worked: 3 of 10 answered is 30 %.
      completeness: 30,
      draftedKeys: ['references', 'assets', 'tech'],
    });
    expect(transport.requests[0]?.prompt).toContain(
      '- outcome: What is the end result you need, in one sentence?',
    );
    expect(transport.requests[0]?.prompt).toContain('the loyalty bit can wait');

    const stored = await loadDiscoverySession(db, thread);
    expect(Number(stored?.completeness)).toBe(30);
    expect(stored?.answers.users).toMatchObject({ answer: 'Their customers', source: 'client' });
    expect(stored?.answers.budget).toBeUndefined();
    expect(Object.keys(stored?.asked ?? {}).sort()).toEqual(['assets', 'references', 'tech']);

    const drafted = await drafts();
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ approved_by: null, sent_at: null });
    expect(drafted[0]?.body).toContain('1. Do you have examples you like (links, screenshots)?');
    expect(drafted[0]?.body).not.toContain('Who signs off');
    expect((drafted[0]?.body.match(/^\d+\. /gm) ?? []).length).toBe(3);

    const updated = await listEvents(db, { type: 'discovery.updated' });
    expect(updated[0]?.payload).toMatchObject({
      captured: ['outcome', 'users', 'day_one'],
      completeness: 30,
    });
    expect((await listEvents(db, { type: 'message.drafted' }))[0]?.payload).toMatchObject({
      via: 'discovery',
    });
    const calls = await db.query<{ purpose: string; outcome: string }>(
      'select purpose::text as purpose, outcome::text as outcome from llm_calls',
    );
    expect(calls.rows).toEqual([{ purpose: 'discovery', outcome: 'ok' }]);
  });

  it('a second reply fills more in; a question already answered is not overwritten; every batch stays under the set', async () => {
    const id = await inbound(
      'Budget about R20 000 fixed. Deadline end of November, not fixed. Actually the outcome is a marketplace.',
    );
    const transport = new ScriptedTransport([
      JSON.stringify({
        answers: [
          { key: 'budget', answer: 'About R20 000, fixed', confidence: 0.9 },
          { key: 'deadline', answer: 'End of November, not fixed', confidence: 0.9 },
          { key: 'outcome', answer: 'A marketplace', confidence: 0.9 },
        ],
      }),
    ]);
    const run = await runDiscovery(
      { db, transport, model: MODEL, now: () => NOW },
      { messageId: id },
    );
    expect(run).toMatchObject({
      status: 'updated',
      captured: ['budget', 'deadline'],
      completeness: 50,
    });
    const stored = await loadDiscoverySession(db, thread);
    expect(stored?.answers.outcome?.answer).toBe('An online shop');
    // The asked-but-unanswered three come after the never-asked ones; still three.
    expect((run as { draftedKeys: string[] }).draftedKeys).toEqual([
      'acceptance',
      'sign_off',
      'references',
    ]);
    expect(await drafts()).toHaveLength(2);
  });

  it('a reply the model cannot read into JSON twice is final, recorded, and drafts nothing', async () => {
    const id = await inbound('???');
    const transport = new ScriptedTransport(['not json', 'still not json']);
    await expect(
      runDiscovery({ db, transport, model: MODEL, now: () => NOW }, { messageId: id }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(transport.requests).toHaveLength(2);
    const calls = await db.query<{ outcome: string }>(
      `select outcome::text as outcome from llm_calls order by created_at desc limit 1`,
    );
    expect(calls.rows[0]?.outcome).toBe('invalid_output');
    expect((await listEvents(db, { type: 'discovery.updated' }))[0]).toMatchObject({
      outcome: 'error',
    });
    expect(await drafts()).toHaveLength(2);
  });

  it('once every question is answered, a reply changes nothing and nothing more is drafted', async () => {
    const remaining = Object.fromEntries(
      DISCOVERY_QUESTIONS.filter(
        (q) => !['outcome', 'users', 'day_one', 'budget', 'deadline'].includes(q.key),
      ).map((q) => [q.key, 'x']),
    );
    const id = await inbound('Everything else answered.');
    const transport = new ScriptedTransport([
      JSON.stringify({
        answers: Object.keys(remaining).map((key) => ({ key, answer: 'x', confidence: 1 })),
      }),
    ]);
    const run = await runDiscovery(
      { db, transport, model: MODEL, now: () => NOW },
      { messageId: id },
    );
    expect(run).toMatchObject({
      status: 'updated',
      completeness: 100,
      draftedMessageId: null,
      draftedKeys: [],
    });
    const later = await inbound('Thanks!');
    expect(
      await runDiscovery(
        { db, transport: new ScriptedTransport([]), model: MODEL },
        { messageId: later },
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'complete',
    });
    expect(await drafts()).toHaveLength(2);
  });
});
