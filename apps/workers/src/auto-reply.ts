import { liveGate, operatorIsOffline } from '@arbitron/core';
import { inTransaction, recordEvent, type Queryable } from '@arbitron/db';
import {
  AccountNotConnectedError,
  FreelancerError,
  freelancerAccessToken,
  postThreadMessage,
  type Fetch,
  type FreelancerConfig,
} from '@arbitron/freelancer';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';

/**
 * The auto-reply worker (ARB-121, docs/01 section E): "inbound while operator offline —
 * sends the configured first reply once per thread only". One job per new inbound
 * message, queued by the inbox sync. In order: the message must be inbound on an open
 * thread; the org must have an active auto-reply with its approval (docs/02 D-08, 0020);
 * the thread must have had no reply yet and no auto-reply (0006's unique key is the
 * guarantee); the operator must be offline (no message has left the org for the
 * period). Only then is the reply written as an outbound message with the approval,
 * the send recorded, and the live gate checked exactly as the submit worker checks it
 * (D-032): with either switch off the reply stays unsent and what would have gone is in
 * the audit log. Live, it is posted with the documented call, and a platform failure
 * undoes the record so the queue can try again.
 */
export interface AutoReplyJobData {
  readonly messageId: string;
  readonly requestId?: string;
}

export interface AutoReplyDeps {
  /** A service-role connection: the worker acts for whichever org owns the message. */
  readonly db: Queryable;
  /** LIVE_MODE from the environment. */
  readonly liveMode: boolean;
  readonly config: FreelancerConfig | null;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

export type AutoReplySkipReason =
  | 'not_inbound'
  | 'thread_closed'
  | 'not_configured'
  | 'already_sent'
  | 'already_replied'
  | 'operator_online'
  | 'no_account'
  | 'no_client';

export type AutoReplyResult =
  | { readonly status: 'sent'; readonly messageId: string; readonly externalMessageId: string }
  | {
      readonly status: 'blocked';
      readonly reason: 'live_mode_off';
      readonly messageId: string;
      readonly message: string;
    }
  | { readonly status: 'skipped'; readonly reason: AutoReplySkipReason; readonly message: string };

interface InboundRow {
  id: string;
  org_id: string;
  thread_id: string;
  direction: string;
  external_thread_id: string;
  thread_status: string;
}

interface ReplyRow {
  id: string;
  body: string;
  offline_after_minutes: number;
  approved_by: string | null;
}

export async function autoReply(
  deps: AutoReplyDeps,
  data: AutoReplyJobData,
): Promise<AutoReplyResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<InboundRow>(
    `select m.id, m.org_id, m.thread_id, m.direction::text as direction,
            t.external_thread_id, t.status::text as thread_status
       from messages m join threads t on t.id = m.thread_id
      where m.id = $1`,
    [data.messageId],
  );
  const inbound = rows[0];
  if (!inbound) throw new UnrecoverableError(`message ${data.messageId} does not exist`);
  if (inbound.direction !== 'in') {
    return {
      status: 'skipped',
      reason: 'not_inbound',
      message: 'Only a client message gets an auto-reply.',
    };
  }

  const outcome = (
    result: 'ok' | 'blocked' | 'skipped' | 'error',
    payload: Record<string, unknown>,
    subjectId: string | null = inbound.id,
  ): Promise<string> =>
    recordEvent(db, {
      orgId: inbound.org_id,
      type: 'auto_reply.sent',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId,
      requestId,
      outcome: result,
      payload: { thread_id: inbound.thread_id, inbound_message_id: inbound.id, ...payload },
    });
  const skip = async (reason: AutoReplySkipReason, message: string): Promise<AutoReplyResult> => {
    await outcome('skipped', { reason, message });
    return { status: 'skipped', reason, message };
  };

  if (inbound.thread_status === 'closed') {
    return skip('thread_closed', 'The thread is closed, so no auto-reply is sent.');
  }

  const replies = await db.query<ReplyRow>(
    `select id, body, offline_after_minutes, approved_by
       from auto_replies where org_id = $1 and active order by updated_at desc limit 1`,
    [inbound.org_id],
  );
  const reply = replies.rows[0];
  if (!reply) {
    return skip('not_configured', 'No auto-reply is switched on in Settings (docs/02 D-08).');
  }
  if (!reply.approved_by) {
    return skip(
      'not_configured',
      'The auto-reply has no approval recorded. Save it again in Settings with the switch on.',
    );
  }

  const sent = await db.query('select 1 from auto_reply_sends where thread_id = $1', [
    inbound.thread_id,
  ]);
  if (sent.rows[0]) return skip('already_sent', 'This thread has had its one auto-reply.');
  const replied = await db.query(
    `select 1 from messages where thread_id = $1 and direction = 'out' limit 1`,
    [inbound.thread_id],
  );
  if (replied.rows[0])
    return skip('already_replied', 'Someone has already replied on this thread.');

  const last = await db.query<{ last: string | null }>(
    `select max(sent_at)::text as last from messages
      where org_id = $1 and direction = 'out' and sent_at is not null`,
    [inbound.org_id],
  );
  const lastOutboundAt = last.rows[0]?.last ? new Date(last.rows[0].last) : null;
  if (
    !operatorIsOffline({ lastOutboundAt, now, offlineAfterMinutes: reply.offline_after_minutes })
  ) {
    return skip(
      'operator_online',
      `A message left this organisation less than ${String(reply.offline_after_minutes)} minutes ago, so someone is online.`,
    );
  }

  // The record first: the unique key on the thread makes a second reply impossible.
  let messageId: string;
  try {
    messageId = await inTransaction(db, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `insert into messages (org_id, thread_id, direction, body, approved_by, approved_via, origin)
         values ($1, $2, 'out', $3, $4, 'auto', 'app') returning id`,
        [inbound.org_id, inbound.thread_id, reply.body, reply.approved_by],
      );
      const id = inserted.rows[0]!.id;
      await tx.query(
        `insert into auto_reply_sends (org_id, thread_id, auto_reply_id, message_id) values ($1, $2, $3, $4)`,
        [inbound.org_id, inbound.thread_id, reply.id, id],
      );
      return id;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /auto_reply_sends_thread_id_key|duplicate key/.test(error.message)
    ) {
      return skip('already_sent', 'This thread has had its one auto-reply.');
    }
    throw error;
  }
  const undo = async () => {
    await db.query('delete from auto_reply_sends where message_id = $1', [messageId]);
    await db.query('delete from messages where id = $1', [messageId]);
  };

  const settings = await db.query<{ live_mode: boolean }>(
    'select live_mode from settings where org_id = $1',
    [inbound.org_id],
  );
  const gate = liveGate({
    envLiveMode: deps.liveMode,
    orgLiveMode: settings.rows[0]?.live_mode ?? false,
  });
  if (!gate.live) {
    const message = gate.message.replace('The bid that', 'The reply that');
    await recordEvent(db, {
      orgId: inbound.org_id,
      type: 'external.blocked_by_live_mode',
      subjectTable: 'messages',
      subjectId: messageId,
      requestId,
      outcome: 'blocked',
      payload: {
        closedBy: gate.closedBy,
        wouldSend: { external_thread_id: inbound.external_thread_id, message: reply.body },
      },
    });
    await outcome(
      'blocked',
      { reason: 'live_mode_off', message, closedBy: gate.closedBy, message_id: messageId },
      messageId,
    );
    return { status: 'blocked', reason: 'live_mode_off', messageId, message };
  }

  const accounts = await db.query<{ id: string }>(
    `select id from platform_accounts where org_id = $1 and platform = 'freelancer' and status = 'connected'`,
    [inbound.org_id],
  );
  const account = accounts.rows[0];
  if (!account) {
    await undo();
    return skip('no_account', 'No Freelancer.com account is connected, so nothing can be sent.');
  }
  if (!deps.config) {
    await undo();
    return skip(
      'no_client',
      'Freelancer.com is not configured (docs/02 B-03), so nothing can be sent.',
    );
  }
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};
  let accessToken: string;
  try {
    accessToken = await freelancerAccessToken(
      { db, config: deps.config, ...fetchDeps, now: () => now },
      account.id,
    );
  } catch (error) {
    await undo();
    if (error instanceof AccountNotConnectedError) return skip('no_account', error.message);
    throw error;
  }

  try {
    const result = await postThreadMessage(
      deps.config,
      accessToken,
      inbound.external_thread_id,
      reply.body,
      fetchDeps,
    );
    await recordEvent(db, {
      orgId: inbound.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId: messageId,
      requestId,
      outcome: 'ok',
      payload: {
        service: 'freelancer',
        call: 'messages/0.1/threads/{thread_id}/messages',
        request_id: result.requestId,
        rate_limit: result.rateLimit,
      },
    });
    const sentAt = result.timeCreated ?? now;
    await db.query(`update messages set sent_at = $2, external_message_id = $3 where id = $1`, [
      messageId,
      sentAt.toISOString(),
      result.id,
    ]);
    await db.query(
      `update threads set last_message_at = greatest(coalesce(last_message_at, $2), $2),
              status = 'awaiting_client' where id = $1`,
      [inbound.thread_id, sentAt.toISOString()],
    );
    await outcome('ok', { message_id: messageId, external_message_id: result.id }, messageId);
    return { status: 'sent', messageId, externalMessageId: result.id };
  } catch (error) {
    if (!(error instanceof FreelancerError)) throw error;
    await recordEvent(db, {
      orgId: inbound.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId: inbound.id,
      requestId,
      outcome: 'error',
      payload: {
        service: 'freelancer',
        call: 'messages/0.1/threads/{thread_id}/messages',
        status: error.status,
        error_code: error.errorCode,
        request_id: error.requestId,
        rate_limit: error.rateLimit ?? null,
      },
    });
    await undo();
    await outcome('error', {
      reason: error.message,
      status: error.status,
      retry: !error.isAuthFailure,
    });
    if (error.isAuthFailure) throw new UnrecoverableError(error.message);
    throw error;
  }
}

export function createAutoReplyProcessor(deps: AutoReplyDeps) {
  return (job: Job<AutoReplyJobData>): Promise<AutoReplyResult> => autoReply(deps, job.data);
}

/** One job per inbound message: BullMQ drops an add whose id is already queued. */
export function enqueueAutoReply(queue: Queue, data: AutoReplyJobData) {
  return queue.add('auto-reply', data, { jobId: `auto-reply__${data.messageId}` });
}
