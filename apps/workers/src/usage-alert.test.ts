import { randomUUID } from 'node:crypto';
import { createFakeEmail } from '@arbitron/email/fake';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scoreJob } from './score.js';
import { createUsageAlert } from './usage-alert.js';

/**
 * ARB-410 acceptance: "Limit reached blocks action with message; alerts sent". The score
 * worker is the action (a model call per job); the plan is test data with a made-up name
 * and a limit of five (no real plan exists: docs/02 D-12); Telegram and email are
 * stand-ins that keep what they were given (B-09, B-13).
 */
const ORG = fixtureId('b', ENTITY.org);
const MODEL = 'claude-opus-5';
let db: PGlite;

class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  async send(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      text: JSON.stringify({
        score: 70,
        verdict: 'go',
        reasons: ['Clear scope.', 'Budget in range.'],
        flags: [],
        reply_probability: 0.3,
      }),
      model: request.model,
      usage: { inputTokens: 1_000, outputTokens: 200 },
    };
  }
}

async function insertJob(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, description, budget_min_minor,
                       budget_max_minor, currency)
     values ($1, 'freelancer', $2, '{}'::jsonb, 'A job', 'A WordPress site.', 300000, 500000, 'ZAR')
     returning id`,
    [ORG, `plan-${randomUUID()}`],
  );
  return rows[0]!.id;
}

let telegram: { chatId: string; text: string }[];
let email: ReturnType<typeof createFakeEmail>;
let transport: ScriptedTransport;
const deps = () => ({
  db,
  transport,
  model: MODEL,
  usageAlert: createUsageAlert({
    db,
    telegram: async (chatId: string, text: string) => {
      telegram.push({ chatId, text });
    },
    email,
  }),
});

async function events(type: string) {
  const { rows } = await db.query<{ outcome: string | null; payload: Record<string, unknown> }>(
    `select outcome, payload from events where org_id = $1 and type = $2 order by created_at, id`,
    [ORG, type],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('b')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'b', 'b')) await db.exec(row.sql);
  // A customer org (ARB-400), on a test plan of five scores a month.
  await db.exec(`update orgs set billing_exempt = false, name = 'New Studio' where id = '${ORG}'`);
  await db.exec(`insert into plans (code, name, limits) values
    ('test-five', 'Test plan', '{"jobs_scored": 5, "bids_drafted": null, "bids_submitted": null}')`);
  await db.exec(
    `update subscriptions set plan = 'test-five', status = 'active' where org_id = '${ORG}'`,
  );
}, 60_000);

beforeEach(() => {
  telegram = [];
  email = createFakeEmail();
  transport = new ScriptedTransport();
});

afterAll(async () => {
  await db.close();
});

describe('scoring against a plan of five a month', () => {
  it('scores up to the limit, alerting the owner at 80 % and at 100 %', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const result = await scoreJob(deps(), { jobId: await insertJob() });
      expect(result.status).toBe('scored');
      // The owner is told exactly as each threshold is crossed: at the 4th and the 5th.
      expect(telegram).toHaveLength(i >= 5 ? 2 : i >= 4 ? 1 : 0);
    }
    expect(telegram.map((m) => m.chatId)).toEqual(['tg-b', 'tg-b']);
    expect(telegram[0]!.text).toMatch(
      /^New Studio: Jobs scored at 80% of the limit\n\nJobs scored: 4 of 5 used this month on the Test plan plan\./,
    );
    expect(telegram[1]!.text).toMatch(/^New Studio: Jobs scored limit reached\n\n/);
    expect(email.sent.map((m) => [m.to, m.subject])).toEqual([
      ['b@example.test', 'New Studio: Jobs scored at 80% of the limit'],
      ['b@example.test', 'New Studio: Jobs scored limit reached'],
    ]);

    const reached = await events('usage.threshold_reached');
    expect(reached.map((e) => [e.payload.threshold, e.payload.used, e.payload.limit])).toEqual([
      [80, 4, 5],
      [100, 5, 5],
    ]);
    const sent = await events('usage.alert_sent');
    expect(sent.map((e) => [e.outcome, e.payload.telegram, e.payload.email])).toEqual([
      ['ok', 1, 1],
      ['ok', 1, 1],
    ]);
    // Counts only: no address or chat id in the audit log.
    expect(JSON.stringify(sent)).not.toMatch(/b@example\.test|tg-b/);
  });

  it('refuses the sixth with the message, pays for no model call, and alerts nobody again', async () => {
    const jobId = await insertJob();
    const result = await scoreJob(deps(), { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'plan_limit' });
    if (result.status === 'blocked') {
      expect(result.message).toMatch(
        /^The Test plan plan's monthly limit for scoring jobs is reached: 5 of 5 used\. It resets on \d{2}\/\d{2}\/\d{4}\. Choose a bigger plan in Settings to go on now\.$/,
      );
    }
    expect(transport.requests).toHaveLength(0);
    expect(telegram).toEqual([]);
    expect(email.sent).toEqual([]);
    const blocked = (await events('job.scored')).filter((e) => e.outcome === 'blocked');
    expect(blocked.at(-1)?.payload).toMatchObject({ reason: 'plan_limit', plan: 'limit_reached' });
    const { rows } = await db.query('select 1 from job_scores where job_id = $1', [jobId]);
    expect(rows).toEqual([]);
  });

  it('gives a score back when the model cannot be reached', async () => {
    await db.query(
      `update usage_counters set used = 2 where org_id = $1 and metric = 'plan:jobs_scored'`,
      [ORG],
    );
    const down: LlmTransport = {
      send: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(
      scoreJob({ ...deps(), transport: down }, { jobId: await insertJob() }),
    ).rejects.toThrow(/connection refused/);
    const { rows } = await db.query<{ used: number }>(
      `select used from usage_counters where org_id = $1 and metric = 'plan:jobs_scored'`,
      [ORG],
    );
    expect(rows[0]?.used).toBe(2);
  });
});

describe('the alert itself', () => {
  const alert = {
    orgId: ORG,
    orgName: 'New Studio',
    planName: 'Test plan',
    metric: 'bids_submitted' as const,
    threshold: 80 as const,
    used: 8,
    limit: 10,
    period: { start: '2026-09-01', resetsOn: '2026-10-01' },
  };

  it('without an email provider, sends Telegram only and records why email was not sent', async () => {
    const send = createUsageAlert({
      db,
      telegram: async (chatId, text) => {
        telegram.push({ chatId, text });
      },
      emailOffReason: 'No email provider is configured (docs/02 B-13), so no email is sent.',
    });
    expect(await send(alert)).toEqual({ telegram: 1, email: 0, failures: 0 });
    const last = (await events('usage.alert_sent')).at(-1);
    expect(last?.payload.emailOff).toMatch(/B-13/);
  });

  it('counts a failed send and carries on with the rest', async () => {
    email.failNext();
    const send = createUsageAlert({
      db,
      telegram: async () => {
        throw new Error('Telegram is down');
      },
      email,
    });
    expect(await send(alert)).toEqual({ telegram: 0, email: 0, failures: 2 });
    expect((await events('usage.alert_sent')).at(-1)?.outcome).toBe('error');
  });

  it('with neither channel, records that nobody could be told', async () => {
    const send = createUsageAlert({ db });
    expect(await send(alert)).toEqual({ telegram: 0, email: 0, failures: 0 });
    const last = (await events('usage.alert_sent')).at(-1);
    expect(last?.outcome).toBe('skipped');
    expect(last?.payload.telegramOff).toMatch(/B-09/);
  });
});
