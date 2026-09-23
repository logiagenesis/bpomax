import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TelegramApi } from './api.js';
import type { BotDeps } from './engine.js';
import { notifyReprice, renderReprice, repriceAlert } from './reprice.js';

/**
 * ARB-204: "alert fires on breach". The evaluation row is what the reprice worker leaves;
 * the card goes to every linked owner or operator chat in the org, and to nobody else,
 * with the stored figures only.
 */
const ORG = fixtureId('a', ENTITY.org);
const OWNER = fixtureId('a', ENTITY.user);
const VIEWER = fixtureId('b', ENTITY.user);
const JOB = fixtureId('a', ENTITY.job);
const CANDIDATE = fixtureId('a', ENTITY.candidate);
const OWNER_CHAT = '1001';
const VIEWER_CHAT = '1002';
let db: PGlite;
let evaluationId: string;

class ScriptedTelegram implements TelegramApi {
  readonly sent: { chatId: string; text: string; buttons?: unknown }[] = [];
  sendMessage(chatId: string, text: string, buttons?: unknown) {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
    return Promise.resolve({ messageId: this.sent.length });
  }
  answerCallbackQuery() {
    return Promise.resolve();
  }
  editMessageReplyMarkup() {
    return Promise.resolve();
  }
  setWebhook() {
    return Promise.resolve();
  }
  getMe() {
    return Promise.resolve({ id: 1, username: 'arbitron_test_bot' });
  }
}

const api = new ScriptedTelegram();
const deps = (): BotDeps => ({ db, api });
/** formatMoney groups with a no-break space; the expectations are typed with a plain one. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG, 'a', 'a')) await db.exec(row.sql);
  await db.query(`update users set telegram_chat_id = $2 where id = $1`, [OWNER, OWNER_CHAT]);
  await db.query(`update users set telegram_chat_id = $2 where id = $1`, [VIEWER, VIEWER_CHAT]);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [
    ORG,
    VIEWER,
  ]);
  await db.query(`update jobs set title = 'Shopify store rebuild' where id = $1`, [JOB]);
  await db.query(
    `update supplier_candidates set display_name = 'kolkata-devs', quoted_price_minor = 420000, currency = 'ZAR'
      where id = $1`,
    [CANDIDATE],
  );
  // R5 000,00 − R500,00 − R4 200,00 = R300,00, 6% of the budget, judged against 20% and R500,00.
  const { rows } = await db.query<{ id: string }>(
    `insert into margin_evaluations (org_id, job_id, currency, client_budget_minor, platform_fee_minor,
       supplier_cost_minor, fx_buffer_minor, margin_minor, margin_pct, min_margin_pct, min_margin_zar_minor, passed)
     values ($1, $2, 'ZAR', 500000, 50000, 420000, 0, 30000, 6.000, 20.000, 50000, false) returning id`,
    [ORG, JOB],
  );
  evaluationId = rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('notifyReprice', () => {
  it('sends the card to the linked owner, not the viewer, with the stored quote, margin and rule', async () => {
    expect(await notifyReprice(deps(), { orgId: ORG, candidateId: CANDIDATE, evaluationId })).toBe(
      1,
    );
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ chatId: OWNER_CHAT });
    expect(api.sent[0]?.buttons).toBeUndefined();
    expect(plain(api.sent[0]!.text)).toBe(
      [
        'Margin below the rule after a supplier quote',
        'Job: Shopify store rebuild',
        'Quote: R4 200,00 from kolkata-devs',
        'Margin: R300,00 (6,0%)',
        'Rule: at least 20,0% and R500,00',
        '',
        'Nothing has been sent. Open the sourcing page to choose another candidate.',
      ].join('\n'),
    );
  });

  it('an evaluation of another org, or an unknown one, sends nothing', async () => {
    expect(
      await notifyReprice(deps(), {
        orgId: fixtureId('b', ENTITY.org),
        candidateId: CANDIDATE,
        evaluationId,
      }),
    ).toBe(0);
    expect(
      await notifyReprice(deps(), {
        orgId: ORG,
        candidateId: CANDIDATE,
        evaluationId: fixtureId('f', ENTITY.margin),
      }),
    ).toBe(0);
    expect(api.sent).toHaveLength(1);
  });

  it('an hourly job states the percentage rule only; repriceAlert is the worker’s dependency', async () => {
    const text = renderReprice({
      jobTitle: null,
      candidate: 'a',
      quoteMinor: 2_500,
      quoteCurrency: 'USD',
      currency: 'USD',
      marginMinor: 250,
      marginPct: '10.000',
      minMarginPct: '20.000',
      minMarginZarMinor: 50_000,
      hourly: true,
    });
    expect(text).toContain('Rule: at least 20,0%\n');
    expect(text).toContain('Job: no title');
    const alert = repriceAlert(deps());
    expect(await alert({ orgId: ORG, candidateId: CANDIDATE, evaluationId })).toBe(1);
    expect(api.sent).toHaveLength(2);
  });
});
