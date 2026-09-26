import { bidPeriod, canApprove, isRole, type Role } from '@arbitron/core';
import { bidUsage, inTransaction, recordEvent, type Queryable } from '@arbitron/db';
import { enqueueSubmit } from '@arbitron/workers';
import type { Queue } from 'bullmq';
import type { Incoming, IncomingCallback, IncomingMessage, TelegramApi } from './api.js';
import { cardButtons, loadCard, renderCard } from './cards.js';

/**
 * What the bot does with each update (ARB-050, docs/01 section I): `/start` links a
 * chat to a person with a one-time code, `/queue`, `/pause`, `/resume` and `/stats` are
 * the commands, and the cards' buttons approve, edit or reject a bid.
 *
 * The bot acts under service_role but always as a person: every write names the linked
 * user, and an approval is refused for a role that may not approve (01 section H). It
 * never talks to a client and never touches a marketplace; a bid it approves is handed to
 * the submit worker, which holds the live gate and the allowance.
 */
export interface BotDeps {
  readonly db: Queryable;
  readonly api: TelegramApi;
  /** The submit queue. Absent, an approval is recorded and left for the queue to be wired. */
  readonly submitQueue?: Queue | null;
  readonly now?: () => Date;
}

export interface LinkedUser {
  readonly userId: string;
  readonly fullName: string | null;
  readonly orgId: string;
  readonly orgName: string;
  readonly role: Role;
}

const NOT_LINKED =
  'This chat is not linked to Arbitron yet. In Settings, create a Telegram link code, then send it here as /start <code>.';

const HELP = [
  'Arbitron commands:',
  '/queue — bids waiting for approval',
  '/pause — stop sending bids',
  '/resume — start sending again',
  '/stats — this month at a glance',
].join('\n');

export async function linkedUser(db: Queryable, chatId: string): Promise<LinkedUser | null> {
  const { rows } = await db.query<{
    user_id: string;
    full_name: string | null;
    org_id: string;
    org_name: string;
    role: string;
  }>(
    `select u.id as user_id, u.full_name, m.org_id, o.name as org_name, m.role::text as role
     from users u
     join memberships m on m.user_id = u.id
     join orgs o on o.id = m.org_id
     where u.telegram_chat_id = $1
     order by (m.role = 'owner') desc, (m.role = 'operator') desc, m.created_at
     limit 1`,
    [chatId],
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  return {
    userId: row.user_id,
    fullName: row.full_name,
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
  };
}

async function link(deps: BotDeps, incoming: IncomingMessage, code: string): Promise<void> {
  const { db, api } = deps;
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  // The code is claimed and used in one conditional update, inside the transaction that
  // links the chat, so two chats sending the same code at once cannot both be linked:
  // the second finds it already used (ARB-500, the owner's audit S-01).
  const linked = await inTransaction(db, async (tx) => {
    const claimed = await tx.query<{
      id: string;
      org_id: string;
      user_id: string;
      full_name: string | null;
      org_name: string;
    }>(
      `with used as (
         update telegram_link_codes set used_at = now()
         where code = $1 and used_at is null and expires_at > $2
         returning id, org_id, user_id
       )
       select used.id, used.org_id, used.user_id, u.full_name, o.name as org_name
       from used
       join users u on u.id = used.user_id
       join orgs o on o.id = used.org_id`,
      [code, now],
    );
    const row = claimed.rows[0];
    if (!row) return null;
    // A chat belongs to one Telegram account; a new code moves it to the person who made the code.
    await tx.query(
      'update users set telegram_chat_id = null where telegram_chat_id = $1 and id <> $2',
      [incoming.chatId, row.user_id],
    );
    await tx.query('update users set telegram_chat_id = $2 where id = $1', [
      row.user_id,
      incoming.chatId,
    ]);
    await recordEvent(tx, {
      orgId: row.org_id,
      type: 'telegram.linked',
      actorUserId: row.user_id,
      subjectTable: 'users',
      subjectId: row.user_id,
      payload: { chatId: incoming.chatId },
    });
    return row;
  });
  if (!linked) {
    await api.sendMessage(
      incoming.chatId,
      'That code is not valid or has expired. Create a new one in Settings and try again.',
    );
    return;
  }
  await api.sendMessage(
    incoming.chatId,
    `Linked to ${linked.org_name}${linked.full_name ? ` as ${linked.full_name}` : ''}. ${HELP}`,
  );
}

async function sendCard(
  deps: BotDeps,
  chatId: string,
  proposalId: string,
  withButtons = true,
): Promise<void> {
  const card = await loadCard(deps.db, proposalId);
  if (!card) return;
  await deps.api.sendMessage(
    chatId,
    renderCard(card),
    withButtons && card.status === 'queued' ? cardButtons(proposalId) : undefined,
  );
}

async function isPaused(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ bidding_paused: boolean }>(
    'select bidding_paused from settings where org_id = $1',
    [orgId],
  );
  return rows[0]?.bidding_paused ?? false;
}

const QUEUE_CARDS = 5;

async function showQueue(deps: BotDeps, chatId: string, user: LinkedUser): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select id from proposals where org_id = $1 and status = 'queued' order by created_at limit $2`,
    [user.orgId, QUEUE_CARDS],
  );
  const { rows: count } = await deps.db.query<{ n: string }>(
    `select count(*)::text as n from proposals where org_id = $1 and status = 'queued'`,
    [user.orgId],
  );
  const total = Number(count[0]?.n ?? 0);
  const paused = (await isPaused(deps.db, user.orgId))
    ? ' Bidding is paused: approved bids wait for /resume.'
    : '';
  if (total === 0) {
    await deps.api.sendMessage(chatId, `Nothing waiting for approval.${paused}`);
    return;
  }
  await deps.api.sendMessage(
    chatId,
    `${String(total)} bid${total === 1 ? '' : 's'} waiting for approval${total > QUEUE_CARDS ? `, the oldest ${String(QUEUE_CARDS)} below` : ''}.${paused}`,
  );
  for (const row of rows) await sendCard(deps, chatId, row.id);
}

async function setPaused(
  deps: BotDeps,
  chatId: string,
  user: LinkedUser,
  paused: boolean,
): Promise<void> {
  if (!canApprove(user.role)) {
    await deps.api.sendMessage(chatId, 'Your role can view but not change whether bids are sent.');
    return;
  }
  await deps.db.query('update settings set bidding_paused = $2 where org_id = $1', [
    user.orgId,
    paused,
  ]);
  await recordEvent(deps.db, {
    orgId: user.orgId,
    type: paused ? 'bidding.paused' : 'bidding.resumed',
    actorUserId: user.userId,
    subjectTable: 'settings',
    payload: { via: 'telegram' },
  });
  if (paused) {
    await deps.api.sendMessage(
      chatId,
      'Paused. Nothing will be sent until /resume; approvals are kept.',
    );
    return;
  }
  const { rows } = await deps.db.query<{ id: string }>(
    `select id from proposals where org_id = $1 and status = 'approved' order by created_at`,
    [user.orgId],
  );
  if (deps.submitQueue) {
    for (const row of rows) await enqueueSubmit(deps.submitQueue, { proposalId: row.id });
  }
  await deps.api.sendMessage(
    chatId,
    `Resumed. ${String(rows.length)} approved bid${rows.length === 1 ? '' : 's'} ${rows.length === 1 ? 'is' : 'are'} being sent.`,
  );
}

async function showStats(deps: BotDeps, chatId: string, user: LinkedUser): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const period = bidPeriod(now);
  const monthStart = new Date(`${period.start}T00:00:00+02:00`).toISOString();
  const { rows: counts } = await deps.db.query<{
    queued: string;
    approved: string;
    submitted: string;
  }>(
    `select count(*) filter (where status = 'queued')::text as queued,
            count(*) filter (where status = 'approved')::text as approved,
            count(*) filter (where status = 'submitted' and submitted_at >= $2)::text as submitted
     from proposals where org_id = $1`,
    [user.orgId, monthStart],
  );
  const { rows: stages } = await deps.db.query<{ stage: string; n: string }>(
    `select stage::text, count(*)::text as n from pipeline_items where org_id = $1 group by stage order by stage`,
    [user.orgId],
  );
  const allowance = await bidUsage(deps.db, { orgId: user.orgId, platform: 'freelancer', now });
  const c = counts[0] ?? { queued: '0', approved: '0', submitted: '0' };
  const lines = [
    `Arbitron, ${period.start.slice(0, 7)}${(await isPaused(deps.db, user.orgId)) ? ' — paused' : ''}`,
    `Waiting for approval: ${c.queued}`,
    `Approved, not yet sent: ${c.approved}`,
    `Sent this month: ${c.submitted}`,
    `Freelancer allowance: ${
      allowance.ok
        ? `${String(allowance.used)} of ${String(allowance.limit)} used`
        : allowance.limit === null
          ? 'not recorded (docs/02 T-03)'
          : `${String(allowance.used)} of ${String(allowance.limit)} used`
    }`,
    `Pipeline: ${stages.length === 0 ? 'empty' : stages.map((s) => `${s.stage} ${s.n}`).join(', ')}`,
  ];
  await deps.api.sendMessage(chatId, lines.join('\n'));
}

interface Pending {
  action: 'edit' | 'reject';
  proposal_id: string;
}

async function pendingFor(db: Queryable, chatId: string): Promise<Pending | null> {
  const { rows } = await db.query<Pending>(
    'select action, proposal_id from telegram_pending where chat_id = $1',
    [chatId],
  );
  return rows[0] ?? null;
}

async function setPending(
  db: Queryable,
  orgId: string,
  chatId: string,
  action: 'edit' | 'reject',
  proposalId: string,
): Promise<void> {
  await db.query(
    `insert into telegram_pending (org_id, chat_id, action, proposal_id) values ($1, $2, $3, $4)
     on conflict (chat_id) do update set org_id = excluded.org_id, action = excluded.action, proposal_id = excluded.proposal_id`,
    [orgId, chatId, action, proposalId],
  );
}

async function completePending(
  deps: BotDeps,
  incoming: IncomingMessage,
  user: LinkedUser,
  pending: Pending,
): Promise<void> {
  const { db, api } = deps;
  const text = incoming.text.trim();
  await db.query('delete from telegram_pending where chat_id = $1', [incoming.chatId]);
  if (text.length === 0) {
    await api.sendMessage(incoming.chatId, 'Nothing changed: the message was empty.');
    return;
  }
  const { rows } = await db.query<{ status: string; org_id: string }>(
    'select status, org_id from proposals where id = $1',
    [pending.proposal_id],
  );
  const proposal = rows[0];
  if (!proposal || proposal.org_id !== user.orgId) {
    await api.sendMessage(incoming.chatId, 'That bid no longer exists.');
    return;
  }
  if (proposal.status === 'submitted') {
    await api.sendMessage(
      incoming.chatId,
      'That bid has already been sent and cannot be changed here.',
    );
    return;
  }
  if (pending.action === 'edit') {
    // New words need a new approval: the old one covered the old words.
    await db.query(
      `update proposals set body = $2, status = 'queued', approved_by = null, approved_via = null where id = $1`,
      [pending.proposal_id, text],
    );
    await recordEvent(db, {
      orgId: user.orgId,
      type: 'proposal.edited',
      actorUserId: user.userId,
      subjectTable: 'proposals',
      subjectId: pending.proposal_id,
      payload: { via: 'telegram', bodyLength: text.length },
    });
    await api.sendMessage(incoming.chatId, 'Updated. Approve it when you are happy with it.');
    await sendCard(deps, incoming.chatId, pending.proposal_id);
    return;
  }
  await db.query(`update proposals set status = 'rejected', failure_reason = $2 where id = $1`, [
    pending.proposal_id,
    text,
  ]);
  await recordEvent(db, {
    orgId: user.orgId,
    type: 'proposal.rejected',
    actorUserId: user.userId,
    subjectTable: 'proposals',
    subjectId: pending.proposal_id,
    payload: { via: 'telegram', reason: text },
  });
  await api.sendMessage(incoming.chatId, `Rejected: ${text}`);
}

async function handleMessage(deps: BotDeps, incoming: IncomingMessage): Promise<void> {
  const { db, api } = deps;
  const text = incoming.text.trim();
  const [command = '', ...args] = text.split(/\s+/);

  if (command === '/start') {
    const code = args[0];
    if (code) return link(deps, incoming, code);
    const user = await linkedUser(db, incoming.chatId);
    await api.sendMessage(
      incoming.chatId,
      user ? `Already linked to ${user.orgName}. ${HELP}` : NOT_LINKED,
    );
    return;
  }

  const user = await linkedUser(db, incoming.chatId);
  if (!user) {
    await api.sendMessage(incoming.chatId, NOT_LINKED);
    return;
  }

  switch (command) {
    case '/queue':
      return showQueue(deps, incoming.chatId, user);
    case '/pause':
      return setPaused(deps, incoming.chatId, user, true);
    case '/resume':
      return setPaused(deps, incoming.chatId, user, false);
    case '/stats':
      return showStats(deps, incoming.chatId, user);
    case '/help':
      await api.sendMessage(incoming.chatId, HELP);
      return;
    default: {
      const pending = await pendingFor(db, incoming.chatId);
      if (pending) return completePending(deps, incoming, user, pending);
      await api.sendMessage(incoming.chatId, HELP);
    }
  }
}

async function approve(
  deps: BotDeps,
  incoming: IncomingCallback,
  user: LinkedUser,
  proposalId: string,
): Promise<void> {
  const { db, api } = deps;
  if (!canApprove(user.role)) {
    await api.answerCallbackQuery(incoming.callbackQueryId, 'Your role cannot approve bids.');
    return;
  }
  const { rows } = await db.query<{ status: string; title: string }>(
    `select p.status, j.title from proposals p join jobs j on j.id = p.job_id where p.id = $1 and p.org_id = $2`,
    [proposalId, user.orgId],
  );
  const proposal = rows[0];
  if (!proposal) {
    await api.answerCallbackQuery(incoming.callbackQueryId, 'That bid no longer exists.');
    return;
  }
  if (proposal.status !== 'queued') {
    const word =
      proposal.status === 'approved'
        ? 'Already approved.'
        : proposal.status === 'submitted'
          ? 'Already sent.'
          : `This bid is ${proposal.status}.`;
    await api.answerCallbackQuery(incoming.callbackQueryId, word);
    return;
  }
  await db.query(
    `update proposals set status = 'approved', approved_by = $2, approved_via = 'telegram' where id = $1 and status = 'queued'`,
    [proposalId, user.userId],
  );
  await recordEvent(db, {
    orgId: user.orgId,
    type: 'proposal.approved',
    actorUserId: user.userId,
    subjectTable: 'proposals',
    subjectId: proposalId,
    payload: { via: 'telegram' },
  });
  if (deps.submitQueue) await enqueueSubmit(deps.submitQueue, { proposalId });
  if (incoming.messageId !== null)
    await api.editMessageReplyMarkup(incoming.chatId, incoming.messageId, null);
  await api.answerCallbackQuery(incoming.callbackQueryId, 'Approved');
  const paused = await isPaused(db, user.orgId);
  await api.sendMessage(
    incoming.chatId,
    `Approved: ${proposal.title}. ${paused ? 'Bidding is paused; it will be sent after /resume.' : 'Sending now.'}`,
  );
}

async function handleCallback(deps: BotDeps, incoming: IncomingCallback): Promise<void> {
  const { db, api } = deps;
  const user = await linkedUser(db, incoming.chatId);
  if (!user) {
    await api.answerCallbackQuery(incoming.callbackQueryId, 'This chat is not linked.');
    return;
  }
  const [action, proposalId] = incoming.data.split(':');
  if (!proposalId || !['approve', 'edit', 'reject'].includes(action ?? '')) {
    await api.answerCallbackQuery(incoming.callbackQueryId);
    return;
  }
  if (action === 'approve') return approve(deps, incoming, user, proposalId);
  if (!canApprove(user.role)) {
    await api.answerCallbackQuery(incoming.callbackQueryId, 'Your role cannot change bids.');
    return;
  }
  await setPending(db, user.orgId, incoming.chatId, action as 'edit' | 'reject', proposalId);
  await api.answerCallbackQuery(incoming.callbackQueryId);
  await api.sendMessage(
    incoming.chatId,
    action === 'edit'
      ? 'Send the new bid text as your next message. It will need approval again.'
      : 'Send the reason for rejecting as your next message.',
  );
}

export async function handleUpdate(deps: BotDeps, incoming: Incoming): Promise<void> {
  if (incoming.kind === 'callback') return handleCallback(deps, incoming);
  return handleMessage(deps, incoming);
}

/** A new bid for approval, pushed to every linked chat that may approve in the org. */
export async function notifyQueued(deps: BotDeps, proposalId: string): Promise<number> {
  const { rows } = await deps.db.query<{ chat_id: string }>(
    `select u.telegram_chat_id as chat_id
     from proposals p
     join memberships m on m.org_id = p.org_id and m.role in ('owner', 'operator')
     join users u on u.id = m.user_id
     where p.id = $1 and u.telegram_chat_id is not null`,
    [proposalId],
  );
  for (const row of rows) await sendCard(deps, row.chat_id, proposalId);
  return rows.length;
}
