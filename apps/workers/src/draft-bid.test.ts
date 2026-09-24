import { randomUUID } from 'node:crypto';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { LlmRequest, LlmResponse, LlmTransport } from '@arbitron/llm';
import type { PGlite } from '@electric-sql/pglite';
import { QueueEvents, UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDraftProcessor, draftBid, enqueueDraft } from './draft-bid.js';
import { evaluateJobMargin } from './margin.js';
import { DEAD_LETTER_QUEUE, closeQueues, createQueues, redisConnection } from './queues.js';
import { startWorker } from './runtime.js';

/**
 * ARB-043 acceptance: "Draft cites only real portfolio items; price equals margin output;
 * milestones sum to bid amount". The model is scripted; the template, the portfolio and
 * the figures are this file's test data (docs/02 D-07 and D-10 are open).
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
    return { text, model: request.model, usage: { inputTokens: 1_500, outputTokens: 400 } };
  }
}

const BODY =
  'Thanks for the brief. We build WordPress sites for small practices and can rebuild yours in ' +
  'Elementor, keeping your content and improving the mobile layout and page speed.';

function reply(fields: { ids?: string[]; days?: number; body?: string } = {}): string {
  return JSON.stringify({
    body: fields.body ?? BODY,
    delivery_days: fields.days ?? 10,
    milestones: [
      { title: 'Design', share: 30 },
      { title: 'Build', share: 30 },
      { title: 'Launch', share: 30 },
    ],
    portfolio_item_ids: fields.ids ?? [],
    operator_notes: 'Check the page count.',
  });
}

async function insertJob(
  key: string,
  fields: { categorySlug?: string | null; currency?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs
       (org_id, platform, external_id, raw, title, description, budget_min_minor, budget_max_minor,
        currency, hourly, skills, client_country, client_payment_verified, client_rating, category_slug)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, 'A 12-page brochure site for a dental practice.',
             300000, 500000, $4, false, '{"WordPress"}', 'ZA', true, 4.8, $5)
     returning id`,
    [
      ORG,
      `${key}-${randomUUID()}`,
      `Job ${key}`,
      fields.currency ?? 'ZAR',
      fields.categorySlug === undefined ? 'web-design' : fields.categorySlug,
    ],
  );
  return rows[0]!.id;
}

async function insertEstimate(jobId: string, turnaround: number | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into delivery_estimates
       (org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor, turnaround_days)
     values ($1, $2, 'web-design', 'rate_card', 'ZAR', 250000, 250000, 250000, $3) returning id`,
    [ORG, jobId, turnaround],
  );
  return rows[0]!.id;
}

async function insertEvaluation(
  jobId: string,
  estimateId: string | null,
  passed: boolean,
  price = 450_000,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into margin_evaluations
       (org_id, job_id, delivery_estimate_id, currency, client_budget_minor, platform_fee_minor,
        supplier_cost_minor, fx_buffer_minor, margin_minor, margin_pct, min_margin_pct,
        min_margin_zar_minor, passed, reason)
     values ($1, $2, $3, 'ZAR', $4, 50000, 250000, 0, 200000, 40.000, 20.000, 50000, $5, 'test')
     returning id`,
    [ORG, jobId, estimateId, price, passed],
  );
  return rows[0]!.id;
}

async function insertTemplate(
  name: string,
  categorySlug: string | null,
  variants: { label: string; body: string }[],
): Promise<string[]> {
  const template = await db.query<{ id: string }>(
    `insert into templates (org_id, name, category_slug) values ($1, $2, $3) returning id`,
    [ORG, `${name} ${randomUUID().slice(0, 8)}`, categorySlug],
  );
  const ids: string[] = [];
  for (const variant of variants) {
    const { rows } = await db.query<{ id: string }>(
      `insert into template_variants (org_id, template_id, label, body)
       values ($1, $2, $3, $4) returning id`,
      [ORG, template.rows[0]!.id, variant.label, variant.body],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

async function insertPortfolio(
  title: string,
  fields: {
    kind?: 'own_work' | 'labelled_demo';
    permission?: boolean;
    active?: boolean;
    url?: string;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into portfolio_items (org_id, title, url, description, category_slug, kind, permission_to_show, active)
     values ($1, $2, $3, 'A clinic site', 'web-design', $4, $5, $6) returning id`,
    [
      ORG,
      `${title} ${randomUUID().slice(0, 8)}`,
      fields.url ?? null,
      fields.kind ?? 'own_work',
      fields.permission ?? true,
      fields.active ?? true,
    ],
  );
  return rows[0]!.id;
}

/** A job with an estimate (7 days), a passed evaluation at R4 500,00 (below the R5 000,00 ceiling), and a template to write from. */
async function readyJob(key: string, turnaround: number | null = 7) {
  const jobId = await insertJob(key);
  const estimateId = await insertEstimate(jobId, turnaround);
  const evaluationId = await insertEvaluation(jobId, estimateId, true);
  return { jobId, estimateId, evaluationId };
}

async function deactivateTemplates() {
  await db.query('update templates set active = false where org_id = $1', [ORG]);
}

async function proposalFor(evaluationId: string) {
  const { rows } = await db.query<{
    id: string;
    status: string;
    amount_minor: string;
    currency: string;
    delivery_days: number;
    milestones: { title: string; amount_minor: number; share: number }[];
    body: string;
    template_variant_id: string | null;
  }>(
    `select id, status, amount_minor::text, currency, delivery_days, milestones, body, template_variant_id
     from proposals where margin_evaluation_id = $1 order by created_at`,
    [evaluationId],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of identityRows('a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  // The fixtures' template and portfolio item are not this file's; each test sets its own.
  await deactivateTemplates();
  await db.query('update portfolio_items set active = false where org_id = $1', [ORG]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('a draft', () => {
  it('is priced by the margin engine, timed by the estimate, split to the cent, and cites real items', async () => {
    await deactivateTemplates();
    const [variantId] = await insertTemplate('Web rebuild', 'web-design', [
      { label: 'A', body: 'Warm, direct, sign off as the studio.' },
    ]);
    const ownWork = await insertPortfolio('Practice site', {
      url: 'https://example.test/practice',
    });
    const { jobId, evaluationId } = await readyJob('draft');
    const requestId = randomUUID();
    const transport = new ScriptedTransport([reply({ ids: [ownWork] })]);

    const result = await draftBid({ db, transport, model: MODEL }, { jobId, requestId });
    expect(result).toMatchObject({ status: 'drafted' });
    if (result.status !== 'drafted') return;

    const [proposal] = await proposalFor(evaluationId);
    expect(proposal).toMatchObject({
      id: result.proposalId,
      status: 'queued',
      amount_minor: '450000',
      currency: 'ZAR',
      delivery_days: 7,
      template_variant_id: variantId,
    });
    // R4 500,00 in three equal shares of R1 500,00; the sum is the price to the cent.
    expect(proposal!.milestones.map((m) => m.amount_minor)).toEqual([150_000, 150_000, 150_000]);
    expect(proposal!.milestones.reduce((sum, m) => sum + m.amount_minor, 0)).toBe(450_000);
    expect(proposal!.body).toMatch(/^Thanks for the brief\./);
    expect(proposal!.body).toMatch(
      /\n\nExamples of our work:\n- Practice site [0-9a-f]+: https:\/\/example\.test\/practice$/,
    );

    const citations = await db.query<{ portfolio_item_id: string }>(
      'select portfolio_item_id from proposal_citations where proposal_id = $1',
      [result.proposalId],
    );
    expect(citations.rows).toEqual([{ portfolio_item_id: ownWork }]);

    const calls = await db.query<{ purpose: string; subject_table: string; subject_id: string }>(
      'select purpose, subject_table, subject_id from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows).toEqual([
      { purpose: 'draft', subject_table: 'proposals', subject_id: result.proposalId },
    ]);
    const events = await db.query<{ outcome: string; payload: Record<string, unknown> }>(
      `select outcome, payload from events where request_id = $1 and type = 'proposal.drafted'`,
      [requestId],
    );
    expect(events.rows[0]).toMatchObject({ outcome: 'ok' });
    expect(events.rows[0]?.payload).toMatchObject({
      amountMinor: 450_000,
      deliveryDays: 7,
      timelineSource: 'estimate',
      operatorNotes: 'Check the page count.',
      citations: [{ id: ownWork, kind: 'own_work' }],
    });
  });

  it('is asked for with the price, the timeline, the template and the permitted items only, never the cost', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [
      { label: 'A', body: 'Sign off as the studio.' },
    ]);
    const allowed = await insertPortfolio('Allowed');
    const noPermission = await insertPortfolio('No permission', { permission: false });
    const inactive = await insertPortfolio('Inactive', { active: false });
    const { jobId } = await readyJob('prompt');
    const transport = new ScriptedTransport([reply({ ids: [allowed] })]);
    await draftBid({ db, transport, model: MODEL }, { jobId });

    const request = transport.requests[0]!;
    expect(request.thinking).toBe(true);
    expect(request.prompt).toContain('Price to quote: 4500.00 ZAR. Quote this figure exactly.');
    expect(request.prompt).not.toContain('Price to quote: 5000.00');
    expect(request.prompt).toContain('Delivery time: 7 days. Quote this exactly.');
    expect(request.prompt).toContain('Sign off as the studio.');
    expect(request.prompt).toContain(allowed);
    expect(request.prompt).not.toContain(noPermission);
    expect(request.prompt).not.toContain(inactive);
    // The supplier cost (R2 500,00) and the margin are the agency's business, not the client's.
    expect(request.prompt).not.toContain('2500.00');
    expect(request.prompt).not.toMatch(/margin|supplier/i);
  });

  it('cannot cite an item that was not offered, and the database refuses one that does not exist', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    await insertPortfolio('Allowed');
    const noPermission = await insertPortfolio('No permission', { permission: false });
    const { jobId, evaluationId } = await readyJob('unoffered');
    const requestId = randomUUID();
    const transport = new ScriptedTransport([
      reply({ ids: [noPermission] }),
      reply({ ids: [noPermission] }),
    ]);

    await expect(
      draftBid({ db, transport, model: MODEL }, { jobId, requestId }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.prompt).toContain('Your previous reply was rejected');
    expect(await proposalFor(evaluationId)).toEqual([]);
    const calls = await db.query<{ outcome: string; attempts: number }>(
      'select outcome, attempts from llm_calls where request_id = $1',
      [requestId],
    );
    expect(calls.rows[0]).toMatchObject({ outcome: 'invalid_output', attempts: 2 });

    const proposal = fixtureId('a', ENTITY.proposal);
    await expect(
      db.query(
        'insert into proposal_citations (org_id, proposal_id, portfolio_item_id) values ($1, $2, $3)',
        [ORG, proposal, randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('keeps a cited item from being deleted from under its proposal', async () => {
    await expect(
      db.query('delete from portfolio_items where id = $1', [fixtureId('a', ENTITY.portfolioItem)]),
    ).rejects.toThrow(/proposal_citations/);
  });

  it('is refused a link in its body, and retried with the reason', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    const { jobId, evaluationId } = await readyJob('link');
    const transport = new ScriptedTransport([
      reply({ body: `${BODY} See https://example.com/work.` }),
      reply(),
    ]);
    const result = await draftBid({ db, transport, model: MODEL }, { jobId });
    expect(result.status).toBe('drafted');
    expect(transport.requests).toHaveLength(2);
    expect((await proposalFor(evaluationId))[0]?.body).not.toContain('https://example.com');
  });
});

describe('templates', () => {
  it('blocks without an approved template, naming D-07, and asks the model nothing', async () => {
    await deactivateTemplates();
    const { jobId, evaluationId } = await readyJob('no-template');
    const transport = new ScriptedTransport([reply()]);
    const result = await draftBid({ db, transport, model: MODEL }, { jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'no_template' });
    if (result.status === 'blocked') expect(result.detail).toMatch(/web-design.*D-07/);
    expect(transport.requests).toHaveLength(0);
    expect(await proposalFor(evaluationId)).toEqual([]);
    const events = await db.query<{ outcome: string }>(
      `select outcome from events where type = 'proposal.drafted' and payload ->> 'jobId' = $1::text`,
      [jobId],
    );
    expect(events.rows).toEqual([{ outcome: 'blocked' }]);
  });

  it('prefers the category s template to a general one, and splits its bids evenly across the variants', async () => {
    await deactivateTemplates();
    await insertTemplate('General', null, [{ label: 'G', body: 'General.' }]);
    const [a, b] = await insertTemplate('Web rebuild', 'web-design', [
      { label: 'A', body: 'Version A.' },
      { label: 'B', body: 'Version B.' },
    ]);
    const picked: (string | null | undefined)[] = [];
    for (const key of ['pick-1', 'pick-2', 'pick-3']) {
      const { jobId, evaluationId } = await readyJob(key);
      await draftBid({ db, transport: new ScriptedTransport([reply()]), model: MODEL }, { jobId });
      picked.push((await proposalFor(evaluationId))[0]?.template_variant_id);
    }
    // Both start at none written: A by label, then B (fewer), then A again.
    expect(picked).toEqual([a, b, a]);
    // A variant switched off is not written from, however few bids it has.
    await db.query('update template_variants set active = false where id = $1', [b]);
    const { jobId, evaluationId } = await readyJob('pick-4');
    await draftBid({ db, transport: new ScriptedTransport([reply()]), model: MODEL }, { jobId });
    expect((await proposalFor(evaluationId))[0]?.template_variant_id).toBe(a);
  });

  it('falls back to a general template for a job with no category', async () => {
    await deactivateTemplates();
    const [general] = await insertTemplate('General', null, [{ label: 'G', body: 'General.' }]);
    const jobId = await insertJob('uncategorised', { categorySlug: null });
    const evaluationId = await insertEvaluation(jobId, await insertEstimate(jobId, 5), true);
    await draftBid({ db, transport: new ScriptedTransport([reply()]), model: MODEL }, { jobId });
    expect((await proposalFor(evaluationId))[0]?.template_variant_id).toBe(general);
  });
});

describe('a read-only marketplace', () => {
  it('drafts nothing for an Upwork job, even with a passed margin, and says why', async () => {
    const { jobId, evaluationId } = await readyJob('upwork');
    await db.query(`update jobs set platform = 'upwork' where id = $1`, [jobId]);
    const transport = new ScriptedTransport([reply()]);
    const result = await draftBid({ db, transport, model: MODEL }, { jobId });
    expect(result).toEqual({ status: 'skipped', reason: 'read_only_platform' });
    expect(await proposalFor(evaluationId)).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    const { rows } = await db.query<{ outcome: string; payload: Record<string, unknown> }>(
      `select outcome, payload from events where type = 'proposal.drafted' and subject_id = $1`,
      [jobId],
    );
    expect(rows[0]).toMatchObject({
      outcome: 'skipped',
      payload: { reason: 'read_only_platform', platform: 'upwork' },
    });
  });
});

describe('what it does without', () => {
  it('drafts with no citations when nothing may be shown', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    await db.query('update portfolio_items set active = false where org_id = $1', [ORG]);
    const { jobId, evaluationId } = await readyJob('no-portfolio');
    const transport = new ScriptedTransport([reply()]);
    await draftBid({ db, transport, model: MODEL }, { jobId });
    expect(transport.requests[0]!.prompt).toContain('Portfolio items available to cite: none.');
    const [proposal] = await proposalFor(evaluationId);
    expect(proposal?.body).not.toContain('Examples of our work');
  });

  it('takes the model s timeline, flagged as proposed, when the estimate has none', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    const { jobId, evaluationId } = await readyJob('no-turnaround', null);
    const transport = new ScriptedTransport([reply({ days: 12 })]);
    await draftBid({ db, transport, model: MODEL }, { jobId });
    expect(transport.requests[0]!.prompt).toContain('propose a realistic number of days');
    expect((await proposalFor(evaluationId))[0]?.delivery_days).toBe(12);
    const events = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from events where type = 'proposal.drafted' and payload ->> 'jobId' = $1::text`,
      [jobId],
    );
    expect(events.rows[0]?.payload).toMatchObject({
      timelineSource: 'proposed_by_model',
      deliveryDays: 12,
    });
  });

  it('skips a failed margin, and a job with no evaluation', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    const failed = await insertJob('failed');
    await insertEvaluation(failed, await insertEstimate(failed, 7), false);
    const transport = new ScriptedTransport([reply()]);
    expect(await draftBid({ db, transport, model: MODEL }, { jobId: failed })).toEqual({
      status: 'skipped',
      reason: 'margin_failed',
    });
    const bare = await insertJob('bare');
    expect(await draftBid({ db, transport, model: MODEL }, { jobId: bare })).toEqual({
      status: 'skipped',
      reason: 'no_margin',
    });
    expect(transport.requests).toHaveLength(0);
    await expect(
      draftBid({ db, transport, model: MODEL }, { jobId: randomUUID() }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('idempotency', () => {
  it('drafts once per evaluation, and again only after a rejection', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    const { jobId, evaluationId } = await readyJob('twice');
    const transport = new ScriptedTransport([reply(), reply()]);
    const first = await draftBid({ db, transport, model: MODEL }, { jobId });
    if (first.status !== 'drafted') throw new Error('expected a draft');
    expect(await draftBid({ db, transport, model: MODEL }, { jobId })).toEqual({
      status: 'already_drafted',
      proposalId: first.proposalId,
    });
    expect(transport.requests).toHaveLength(1);

    await db.query(`update proposals set status = 'rejected' where id = $1`, [first.proposalId]);
    const again = await draftBid(
      { db, transport, model: MODEL },
      { jobId, marginEvaluationId: evaluationId },
    );
    expect(again.status).toBe('drafted');
    expect(await proposalFor(evaluationId)).toHaveLength(2);
  });
});

describe('on the queue', () => {
  const connection = redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

  it('is fed by the margin worker for a passed evaluation only, and drafts what it is fed', async () => {
    await deactivateTemplates();
    await insertTemplate('Web rebuild', 'web-design', [{ label: 'A', body: 'Brief.' }]);
    await db.query(
      `update settings set min_margin_pct = 20, min_margin_zar_minor = 50000, fx_buffer_pct = 3,
         fee_table = $2::jsonb where org_id = $1`,
      [
        ORG,
        JSON.stringify([
          {
            platform: 'freelancer',
            project_type: 'fixed',
            side: 'freelancer',
            percent: 10,
            source_url: 'https://example.test/fees',
            read_on: '2026-09-22',
          },
        ]),
      ],
    );
    const prefix = `arb-test-${randomUUID()}`;
    const queues = createQueues({ connection, prefix, attempts: 3, backoffMs: 10 });
    const events = new QueueEvents('draft-bid', { connection, prefix });
    await events.waitUntilReady();
    const worker = startWorker(
      'draft-bid',
      createDraftProcessor({ db, transport: new ScriptedTransport([reply()]), model: MODEL }),
      { connection, prefix, deadLetter: queues[DEAD_LETTER_QUEUE] },
    );
    try {
      const passing = await insertJob('passing');
      const passingEstimate = await insertEstimate(passing, 7);
      const evaluated = await evaluateJobMargin(
        { db, draftQueue: queues['draft-bid'] },
        { jobId: passing, estimateId: passingEstimate },
      );
      if (evaluated.status !== 'evaluated' || !evaluated.passed) throw new Error('expected a pass');

      // A job whose supplier cost eats the budget fails, and is not drafted.
      const failing = await insertJob('failing');
      const failingEstimate = await db.query<{ id: string }>(
        `insert into delivery_estimates (org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor)
         values ($1, $2, 'web-design', 'rate_card', 'ZAR', 480000, 480000, 480000) returning id`,
        [ORG, failing],
      );
      const failed = await evaluateJobMargin(
        { db, draftQueue: queues['draft-bid'] },
        { jobId: failing, estimateId: failingEstimate.rows[0]!.id },
      );
      expect(failed).toMatchObject({ status: 'evaluated', passed: false });

      const queued = await queues['draft-bid'].getJob(`draft__${evaluated.evaluationId}`);
      expect(queued).toBeDefined();
      if (failed.status === 'evaluated') {
        expect(await queues['draft-bid'].getJob(`draft__${failed.evaluationId}`)).toBeUndefined();
      }
      const again = await enqueueDraft(queues['draft-bid'], {
        jobId: passing,
        marginEvaluationId: evaluated.evaluationId,
      });
      expect(again.id).toBe(queued!.id);

      const result = await queued!.waitUntilFinished(events, 10_000);
      expect(result).toMatchObject({ status: 'drafted' });
      expect((await proposalFor(evaluated.evaluationId))[0]).toMatchObject({
        status: 'queued',
        amount_minor: '500000',
      });
    } finally {
      await worker.close();
      await events.close();
      for (const queue of Object.values(queues)) await queue.obliterate({ force: true });
      await closeQueues(queues);
    }
  }, 30_000);
});

describe('plan limits (ARB-410)', () => {
  // A made-up plan for the test: one draft a month. No real plan exists (docs/02 D-12).
  beforeAll(async () => {
    await db.exec(`insert into plans (code, name, limits) values
      ('test-one-draft', 'Test plan', '{"jobs_scored": null, "bids_drafted": 1, "bids_submitted": null}')`);
    await db.query(
      `update subscriptions set plan = 'test-one-draft', status = 'active' where org_id = $1`,
      [ORG],
    );
    await db.query('update orgs set billing_exempt = false where id = $1', [ORG]);
    // The drafts above were counted while the org was the house org; start this month at 0.
    await db.query(`delete from usage_counters where org_id = $1 and metric like 'plan:%'`, [ORG]);
  });

  afterAll(async () => {
    await db.query('update orgs set billing_exempt = true where id = $1', [ORG]);
  });

  it('drafts while the plan has room, then refuses with the message and asks the model nothing', async () => {
    await insertTemplate('Plan limit', 'web-design', [{ label: 'A', body: 'Words.' }]);
    const first = await readyJob('plan-1');
    const transport = new ScriptedTransport([reply(), reply()]);
    const drafted = await draftBid({ db, transport, model: MODEL }, { jobId: first.jobId });
    expect(drafted, JSON.stringify(drafted)).toMatchObject({ status: 'drafted' });

    const second = await readyJob('plan-2');
    const result = await draftBid({ db, transport, model: MODEL }, { jobId: second.jobId });
    expect(result).toMatchObject({ status: 'blocked', reason: 'plan_limit' });
    if (result.status === 'blocked') {
      expect(result.detail).toMatch(
        /^The Test plan plan's monthly limit for drafting bids is reached: 1 of 1 used\. It resets on \d{2}\/\d{2}\/\d{4}\. Choose a bigger plan in Settings to go on now\.$/,
      );
    }
    expect(transport.requests).toHaveLength(1);
    expect(await proposalFor(second.evaluationId)).toEqual([]);
    const events = await db.query<{ outcome: string; reason: string }>(
      `select outcome, payload ->> 'reason' as reason from events
        where type = 'proposal.drafted' and payload ->> 'jobId' = $1::text`,
      [second.jobId],
    );
    expect(events.rows).toEqual([{ outcome: 'blocked', reason: 'plan_limit' }]);
  });

  it('gives the draft back when the model cannot be reached', async () => {
    await db.query(
      `update usage_counters set used = 0 where org_id = $1 and metric = 'plan:bids_drafted'`,
      [ORG],
    );
    const job = await readyJob('plan-down');
    const down: LlmTransport = {
      send: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(
      draftBid({ db, transport: down, model: MODEL }, { jobId: job.jobId }),
    ).rejects.toThrow(/connection refused/);
    const { rows } = await db.query<{ used: number }>(
      `select used from usage_counters where org_id = $1 and metric = 'plan:bids_drafted'`,
      [ORG],
    );
    expect(rows[0]?.used).toBe(0);
  });
});
