import { randomUUID } from 'node:crypto';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TelegramApi, TelegramButton } from './api.js';
import { handleUpdate, linkedUser, notifyQueued, type BotDeps } from './engine.js';

/**
 * ARB-050 acceptance: "Approve from Telegram submits in sandbox; Edit replaces text;
 * Reject records reason". Telegram is scripted; the sandbox is C-02. Approve here hands
 * the proposal to the submit queue, which is where the sandbox call would happen.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const VIEWER = fixtureId('b', ENTITY.user);
const OWNER_CHAT = '1001';
const VIEWER_CHAT = '1002';
const STRANGER_CHAT = '1999';
const NOW = new Date('2026-09-22T12:00:00Z');
let db: PGlite;

class ScriptedTelegram implements TelegramApi {
  readonly sent: {
    chatId: string;
    text: string;
    buttons?: readonly (readonly TelegramButton[])[];
  }[] = [];
  readonly answered: { id: string; text?: string }[] = [];
  readonly edited: { chatId: string; messageId: number; buttons: unknown }[] = [];
  sendMessage(chatId: string, text: string, buttons?: readonly (readonly TelegramButton[])[]) {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
    return Promise.resolve({ messageId: this.sent.length });
  }
  answerCallbackQuery(id: string, text?: string) {
    this.answered.push({ id, ...(text ? { text } : {}) });
    return Promise.resolve();
  }
  editMessageReplyMarkup(chatId: string, messageId: number, buttons: unknown) {
    this.edited.push({ chatId, messageId, buttons });
    return Promise.resolve();
  }
  setWebhook() {
    return Promise.resolve();
  }
  getMe() {
    return Promise.resolve({ id: 1, username: 'arbitron_test_bot' });
  }
}

class FakeQueue {
  readonly added: { name: string; data: unknown; jobId?: string }[] = [];
  add(name: string, data: unknown, opts?: { jobId?: string }) {
    this.added.push({ name, data, ...(opts?.jobId ? { jobId: opts.jobId } : {}) });
    return Promise.resolve({ id: opts?.jobId ?? name });
  }
}

let api: ScriptedTelegram;
let queue: FakeQueue;
function deps(): BotDeps {
  return { db, api, submitQueue: queue as unknown as Queue, now: () => NOW };
}
const message = (chatId: string, text: string) =>
  handleUpdate(deps(), { kind: 'message', chatId, fromId: chatId, messageId: 1, text });
const press = (chatId: string, data: string, messageId = 5) =>
  handleUpdate(deps(), {
    kind: 'callback',
    chatId,
    fromId: chatId,
    callbackQueryId: `q-${data}`,
    messageId,
    data,
  });

async function insertJob(key: string, currency = 'ZAR'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, budget_max_minor, currency)
     values ($1, 'freelancer', $2, '{}'::jsonb, $3, 500000, $4) returning id`,
    [ORG, `${key}-${randomUUID()}`, `Job ${key}`, currency],
  );
  await db.query(
    `insert into job_scores (org_id, job_id, score, verdict, model) values ($1, $2, 78, 'go', 'm')`,
    [ORG, rows[0]!.id],
  );
  return rows[0]!.id;
}

/** A queued proposal with its estimate and margin behind it, as the workers would leave them. */
async function queuedProposal(
  key: string,
  fields: { currency?: string; status?: string; fx?: string } = {},
) {
  const currency = fields.currency ?? 'ZAR';
  const jobId = await insertJob(key, currency);
  const estimate = await db.query<{ id: string }>(
    `insert into delivery_estimates (org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor, turnaround_days)
     values ($1, $2, 'web-design', 'rate_card', $3, 250000, 250000, 250000, 7) returning id`,
    [ORG, jobId, currency],
  );
  const evaluation = await db.query<{ id: string }>(
    `insert into margin_evaluations
       (org_id, job_id, delivery_estimate_id, currency, client_budget_minor, platform_fee_minor, supplier_cost_minor,
        fx_buffer_minor, margin_minor, margin_pct, min_margin_pct, min_margin_zar_minor, fx_rate_used, passed, reason)
     values ($1, $2, $3, $4, 450000, 45000, 250000, 0, 155000, 34.444, 20, 50000, $5, true, 'test') returning id`,
    [ORG, jobId, estimate.rows[0]!.id, currency, fields.fx ?? null],
  );
  const proposal = await db.query<{ id: string }>(
    `insert into proposals (org_id, job_id, margin_evaluation_id, body, amount_minor, currency, delivery_days, milestones, status)
     values ($1, $2, $3, 'Thanks for the brief. We can rebuild it in Elementor.', 450000, $4, 7,
             '[{"title":"Design","amount_minor":150000},{"title":"Build","amount_minor":300000}]'::jsonb, $5) returning id`,
    [ORG, jobId, evaluation.rows[0]!.id, currency, fields.status ?? 'queued'],
  );
  return { jobId, proposalId: proposal.rows[0]!.id };
}

async function proposalState(id: string) {
  const { rows } = await db.query<{
    status: string;
    body: string;
    approved_by: string | null;
    approved_via: string | null;
    failure_reason: string | null;
  }>(
    'select status, body, approved_by, approved_via, failure_reason from proposals where id = $1',
    [id],
  );
  return rows[0]!;
}

async function lastEventOf(type: string) {
  const { rows } = await db.query<{
    actor_user_id: string | null;
    payload: Record<string, unknown>;
    subject_id: string | null;
  }>(
    `select actor_user_id, payload, subject_id from events where type = $1 order by created_at desc limit 1`,
    [type],
  );
  return rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [
    ORG,
    VIEWER,
  ]);
  await db.query(`update users set telegram_chat_id = $2 where id = $1`, [VIEWER, VIEWER_CHAT]);
  await db.query(`update proposals set status = 'rejected' where org_id = $1`, [ORG]);
  await db.query(`delete from telegram_pending where org_id = $1`, [ORG]);
}, 60_000);

beforeEach(() => {
  api = new ScriptedTelegram();
  queue = new FakeQueue();
});

afterAll(async () => {
  await db.close();
});

describe('linking a chat with a one-time code', () => {
  it('turns away an unlinked chat, and explains how to link', async () => {
    await message(STRANGER_CHAT, '/queue');
    expect(api.sent[0]?.text).toMatch(/not linked.*\/start <code>/);
    await message(STRANGER_CHAT, '/start');
    expect(api.sent[1]?.text).toMatch(/not linked/);
    await press(STRANGER_CHAT, 'approve:x');
    expect(api.answered[0]?.text).toBe('This chat is not linked.');
  });

  it('rejects a code that is wrong or expired', async () => {
    await db.query(
      `insert into telegram_link_codes (org_id, user_id, code, expires_at) values ($1, $2, 'EXPIRED1', $3)`,
      [ORG, OWNER, new Date(NOW.getTime() - 60_000).toISOString()],
    );
    await message(OWNER_CHAT, '/start EXPIRED1');
    await message(OWNER_CHAT, '/start NOSUCH01');
    expect(api.sent.map((m) => m.text)).toEqual([
      expect.stringMatching(/not valid or has expired/),
      expect.stringMatching(/not valid or has expired/),
    ]);
    expect(await linkedUser(db, OWNER_CHAT)).toBeNull();
  });

  it('links the chat to the person who made the code, once', async () => {
    await db.query(
      `insert into telegram_link_codes (org_id, user_id, code, expires_at) values ($1, $2, 'GOODCODE', $3)`,
      [ORG, OWNER, new Date(NOW.getTime() + 60_000).toISOString()],
    );
    await message(OWNER_CHAT, '/start GOODCODE');
    expect(api.sent[0]?.text).toMatch(/^Linked to Org a as User a\./);
    expect(await linkedUser(db, OWNER_CHAT)).toMatchObject({
      userId: OWNER,
      orgId: ORG,
      role: 'owner',
    });
    const code = await db.query<{ used_at: string | null }>(
      `select used_at from telegram_link_codes where code = 'GOODCODE'`,
    );
    expect(code.rows[0]?.used_at).not.toBeNull();
    expect(await lastEventOf('telegram.linked')).toMatchObject({
      actor_user_id: OWNER,
      payload: { chatId: OWNER_CHAT },
    });

    await message(OWNER_CHAT, '/start GOODCODE');
    expect(api.sent[1]?.text).toMatch(/not valid or has expired/);
    await message(OWNER_CHAT, '/start');
    expect(api.sent[2]?.text).toMatch(/^Already linked to Org a/);
  });
});

describe('/queue and the approval card', () => {
  it('says when nothing is waiting', async () => {
    await message(OWNER_CHAT, '/queue');
    expect(api.sent).toEqual([{ chatId: OWNER_CHAT, text: 'Nothing waiting for approval.' }]);
  });

  it('shows each queued bid as a card with the item, score, cost, margin and three buttons', async () => {
    const { proposalId } = await queuedProposal('card');
    await message(OWNER_CHAT, '/queue');
    expect(api.sent[0]?.text).toBe('1 bid waiting for approval.');
    const card = api.sent[1]!;
    expect(card.text).toBe(
      [
        'Bid for approval — queued',
        'Job card',
        'Score: 78 (go)',
        'Price: R4 500,00 · 7 days · 2 milestones',
        'Estimated cost: R2 500,00 (rate card)',
        'Projected margin: R1 550,00 (34,4%)',
        '',
        'Thanks for the brief. We can rebuild it in Elementor.',
      ].join('\n'),
    );
    expect(card.buttons).toEqual([
      [
        { text: 'Approve', callbackData: `approve:${proposalId}` },
        { text: 'Edit', callbackData: `edit:${proposalId}` },
        { text: 'Reject', callbackData: `reject:${proposalId}` },
      ],
    ]);
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });

  it('shows a foreign-currency margin in the deal currency and in ZAR at the stored rate', async () => {
    // USD 1 550,00 at 18.25 is R28 287,50.
    const { proposalId } = await queuedProposal('usd', { currency: 'USD', fx: '18.25' });
    await message(OWNER_CHAT, '/queue');
    expect(api.sent[1]?.text).toContain('Projected margin: USD 1 550,00 (34,4%) · R28 287,50');
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });
});

describe('Approve', () => {
  it('approves as the linked person, hands the bid to the submit queue, and closes the card', async () => {
    const { proposalId } = await queuedProposal('approve');
    await press(OWNER_CHAT, `approve:${proposalId}`, 77);
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'approved',
      approved_by: OWNER,
      approved_via: 'telegram',
    });
    expect(await lastEventOf('proposal.approved')).toMatchObject({
      actor_user_id: OWNER,
      subject_id: proposalId,
    });
    expect(queue.added).toEqual([
      { name: 'submit', data: { proposalId }, jobId: `submit__${proposalId}` },
    ]);
    expect(api.edited).toEqual([{ chatId: OWNER_CHAT, messageId: 77, buttons: null }]);
    expect(api.answered[0]?.text).toBe('Approved');
    expect(api.sent[0]?.text).toBe('Approved: Job approve. Sending now.');

    await press(OWNER_CHAT, `approve:${proposalId}`);
    expect(api.answered[1]?.text).toBe('Already approved.');
    expect(queue.added).toHaveLength(1);
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });

  it('is refused to a viewer, and for a bid that is not this org s', async () => {
    const { proposalId } = await queuedProposal('viewer');
    await press(VIEWER_CHAT, `approve:${proposalId}`);
    expect(api.answered[0]?.text).toBe('Your role cannot approve bids.');
    expect(await proposalState(proposalId)).toMatchObject({ status: 'queued' });
    await press(OWNER_CHAT, `approve:${randomUUID()}`);
    expect(api.answered[1]?.text).toBe('That bid no longer exists.');
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });
});

describe('Edit and Reject', () => {
  it('Edit replaces the text with the next message, and asks for approval again', async () => {
    const { proposalId } = await queuedProposal('edit');
    // Approved first: the edit must take that approval away, since it covered other words.
    await press(OWNER_CHAT, `approve:${proposalId}`);
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'approved',
      approved_by: OWNER,
    });
    api = new ScriptedTelegram();
    await press(OWNER_CHAT, `edit:${proposalId}`);
    expect(api.sent[0]?.text).toMatch(/Send the new bid text/);
    await message(OWNER_CHAT, 'Hello. We would rebuild the site in Elementor within a week.');
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'queued',
      body: 'Hello. We would rebuild the site in Elementor within a week.',
      approved_by: null,
      approved_via: null,
    });
    expect(await lastEventOf('proposal.edited')).toMatchObject({
      actor_user_id: OWNER,
      payload: { via: 'telegram' },
    });
    expect(api.sent[1]?.text).toMatch(/^Updated\./);
    expect(api.sent[2]?.text).toContain('Hello. We would rebuild');
    expect(api.sent[2]?.buttons).toBeDefined();
    const pending = await db.query('select 1 from telegram_pending where chat_id = $1', [
      OWNER_CHAT,
    ]);
    expect(pending.rows).toHaveLength(0);
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });

  it('Reject records the reason from the next message', async () => {
    const { proposalId } = await queuedProposal('reject');
    await press(OWNER_CHAT, `reject:${proposalId}`);
    expect(api.sent[0]?.text).toMatch(/Send the reason/);
    await message(OWNER_CHAT, 'Budget too low for the scope.');
    expect(await proposalState(proposalId)).toMatchObject({
      status: 'rejected',
      failure_reason: 'Budget too low for the scope.',
    });
    expect(await lastEventOf('proposal.rejected')).toMatchObject({
      actor_user_id: OWNER,
      subject_id: proposalId,
      payload: { via: 'telegram', reason: 'Budget too low for the scope.' },
    });
    expect(api.sent[1]?.text).toBe('Rejected: Budget too low for the scope.');
  });

  it('will not change a bid that has been sent, and a viewer may not start an edit', async () => {
    const { proposalId } = await queuedProposal('sent');
    await db.query(
      `update proposals set status = 'submitted', approved_by = $2, approved_via = 'web' where id = $1`,
      [proposalId, OWNER],
    );
    await press(OWNER_CHAT, `edit:${proposalId}`);
    await message(OWNER_CHAT, 'Too late.');
    expect(api.sent[1]?.text).toMatch(/already been sent/);
    expect(await proposalState(proposalId)).toMatchObject({ status: 'submitted' });
    await press(VIEWER_CHAT, `reject:${proposalId}`);
    expect(api.answered.at(-1)?.text).toBe('Your role cannot change bids.');
  });
});

describe('/pause, /resume and /stats', () => {
  it('pauses and resumes, re-queuing what was approved in the meantime', async () => {
    await message(OWNER_CHAT, '/pause');
    expect(api.sent[0]?.text).toMatch(/^Paused\./);
    const paused = await db.query<{ bidding_paused: boolean }>(
      'select bidding_paused from settings where org_id = $1',
      [ORG],
    );
    expect(paused.rows[0]?.bidding_paused).toBe(true);
    expect(await lastEventOf('bidding.paused')).toMatchObject({ actor_user_id: OWNER });

    const { proposalId } = await queuedProposal('while-paused');
    await press(OWNER_CHAT, `approve:${proposalId}`);
    expect(api.sent[1]?.text).toMatch(/Bidding is paused; it will be sent after \/resume/);

    await message(OWNER_CHAT, '/resume');
    expect(api.sent[2]?.text).toBe('Resumed. 1 approved bid is being sent.');
    expect(
      queue.added.filter((j) => (j.data as { proposalId: string }).proposalId === proposalId),
    ).toHaveLength(2);
    expect(await lastEventOf('bidding.resumed')).toMatchObject({ actor_user_id: OWNER });
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);

    await message(VIEWER_CHAT, '/pause');
    expect(api.sent.at(-1)?.text).toMatch(/Your role can view but not change/);
  });

  it('gives the month at a glance', async () => {
    await message(OWNER_CHAT, '/stats');
    const text = api.sent[0]?.text ?? '';
    expect(text).toMatch(/^Arbitron, 2026-09/);
    expect(text).toContain('Waiting for approval: 0');
    expect(text).toContain('Sent this month: 0');
    expect(text).toContain('Freelancer allowance: not recorded (docs/02 T-03)');
    expect(text).toMatch(/Pipeline: /);
  });

  it('answers anything else with the commands', async () => {
    await message(OWNER_CHAT, 'hello?');
    expect(api.sent[0]?.text).toMatch(/^Arbitron commands:/);
  });
});

describe('notifyQueued', () => {
  it('pushes a new card to every linked chat that may approve, and not to viewers', async () => {
    const { proposalId } = await queuedProposal('notify');
    expect(await notifyQueued(deps(), proposalId)).toBe(1);
    expect(api.sent.map((m) => m.chatId)).toEqual([OWNER_CHAT]);
    expect(api.sent[0]?.buttons).toBeDefined();
    await db.query(`update proposals set status = 'rejected' where id = $1`, [proposalId]);
  });
});
