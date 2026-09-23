import type { Queryable } from '@arbitron/db';
import type { InboundAlert } from '@arbitron/workers';
import type { BotDeps } from './engine.js';

/**
 * The operator alert for a new client message (ARB-120, docs/01 section E "alerts
 * operator"): a plain card to every linked chat of an owner or operator in the org. No
 * buttons: replying is ARB-122's approval flow. The inbox-sync worker calls
 * `inboundAlert(deps)` after it has stored the message, so the card reads from the row.
 */
export interface InboundCard {
  readonly clientHandle: string | null;
  readonly jobTitle: string | null;
  readonly body: string;
  readonly sentAt: string | null;
}

const BODY_PREVIEW = 400;

export async function loadInboundCard(
  db: Queryable,
  messageId: string,
): Promise<InboundCard | null> {
  const { rows } = await db.query<{
    body: string;
    sent_at: string | null;
    client_handle: string | null;
    job_title: string | null;
  }>(
    `select m.body, m.sent_at, t.client_handle, j.title as job_title
       from messages m
       join threads t on t.id = m.thread_id
       left join jobs j on j.id = t.job_id
      where m.id = $1 and m.direction = 'in'`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientHandle: row.client_handle,
    jobTitle: row.job_title,
    body: row.body,
    sentAt: row.sent_at,
  };
}

export function renderInbound(card: InboundCard): string {
  const body =
    card.body.length > BODY_PREVIEW ? `${card.body.slice(0, BODY_PREVIEW - 1)}…` : card.body;
  return [
    'New client message',
    `From: ${card.clientHandle ?? 'the client'}`,
    `About: ${card.jobTitle ?? 'no linked job'}`,
    '',
    body || '(no text)',
  ].join('\n');
}

/** Sends the card to every linked chat that may act for the org; returns how many. */
export async function notifyInbound(deps: BotDeps, alert: InboundAlert): Promise<number> {
  const card = await loadInboundCard(deps.db, alert.messageId);
  if (!card) return 0;
  const { rows } = await deps.db.query<{ chat_id: string }>(
    `select u.telegram_chat_id as chat_id
       from memberships m
       join users u on u.id = m.user_id
      where m.org_id = $1 and m.role in ('owner', 'operator') and u.telegram_chat_id is not null`,
    [alert.orgId],
  );
  const text = renderInbound(card);
  for (const row of rows) await deps.api.sendMessage(row.chat_id, text);
  return rows.length;
}

/** The worker's `alert` dependency, bound to this bot. */
export function inboundAlert(deps: BotDeps): (alert: InboundAlert) => Promise<number> {
  return (alert) => notifyInbound(deps, alert);
}
