import { liveGate } from '@arbitron/core';
import { recordEvent, textFingerprint, type Queryable } from '@arbitron/db';
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
 * The send-message worker (ARB-122, docs/01 section H): sends an approved outbound
 * message, and only one. In order: the row must be an app-written outbound message
 * with its approval and not yet sent or rejected; the live gate (D-032), which with
 * either switch off leaves it unsent and writes what would have gone to the audit log;
 * the connected account and its token; then the documented call. A refusal that asking
 * again will not fix (a bad token, a 4xx that is not a rate limit) is recorded on the
 * row as its failure; a rate limit, a 5xx or a network failure goes back to the queue.
 *
 * The approval itself is never checked here alone: 0003's constraint refuses `sent_at`
 * on an app message without `approved_by` and `approved_via`, so nothing leaves without
 * the approval event the API wrote.
 */
export interface SendMessageJobData {
  readonly messageId: string;
  readonly requestId?: string;
}

export interface SendMessageDeps {
  /** A service-role connection: the worker acts for whichever org owns the message. */
  readonly db: Queryable;
  /** LIVE_MODE from the environment. */
  readonly liveMode: boolean;
  readonly config: FreelancerConfig | null;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

export type SendMessageResult =
  | { readonly status: 'sent'; readonly externalMessageId: string }
  | { readonly status: 'already_sent'; readonly externalMessageId: string | null }
  | {
      readonly status: 'skipped';
      readonly reason: 'not_approved' | 'rejected';
      readonly message: string;
    }
  | { readonly status: 'blocked'; readonly reason: 'live_mode_off'; readonly message: string }
  | {
      readonly status: 'failed';
      readonly reason: 'no_account' | 'no_client' | 'refused';
      readonly message: string;
    };

interface MessageRow {
  id: string;
  org_id: string;
  thread_id: string;
  direction: string;
  origin: string;
  body: string;
  approved_by: string | null;
  approved_via: string | null;
  sent_at: string | null;
  rejected_at: string | null;
  external_message_id: string | null;
  external_thread_id: string;
}

export const SEND_MESSAGE_CALL = 'messages/0.1/threads/{thread_id}/messages';

export async function sendMessage(
  deps: SendMessageDeps,
  data: SendMessageJobData,
): Promise<SendMessageResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<MessageRow>(
    `select m.id, m.org_id, m.thread_id, m.direction::text as direction, m.origin, m.body,
            m.approved_by, m.approved_via::text as approved_via, m.sent_at, m.rejected_at,
            m.external_message_id, t.external_thread_id
       from messages m join threads t on t.id = m.thread_id where m.id = $1`,
    [data.messageId],
  );
  const message = rows[0];
  if (!message) throw new UnrecoverableError(`message ${data.messageId} does not exist`);
  if (message.direction !== 'out' || message.origin !== 'app') {
    throw new UnrecoverableError(`message ${data.messageId} is not an outbound message of the app`);
  }
  if (message.sent_at)
    return { status: 'already_sent', externalMessageId: message.external_message_id };

  const note = (
    outcome: 'ok' | 'blocked' | 'skipped' | 'error',
    payload: Record<string, unknown>,
  ): Promise<string> =>
    recordEvent(db, {
      orgId: message.org_id,
      type: 'message.sent',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId: message.id,
      requestId,
      outcome,
      payload: { thread_id: message.thread_id, ...payload },
    });

  if (message.rejected_at) {
    const text = 'This message was rejected, so it is not sent.';
    await note('skipped', { reason: 'rejected', message: text });
    return { status: 'skipped', reason: 'rejected', message: text };
  }
  if (!message.approved_by || !message.approved_via) {
    const text =
      'This message has no approval, so it is not sent. Approve it on the approvals page.';
    await note('skipped', { reason: 'not_approved', message: text });
    return { status: 'skipped', reason: 'not_approved', message: text };
  }

  const settings = await db.query<{ live_mode: boolean }>(
    'select live_mode from settings where org_id = $1',
    [message.org_id],
  );
  const gate = liveGate({
    envLiveMode: deps.liveMode,
    orgLiveMode: settings.rows[0]?.live_mode ?? false,
  });
  if (!gate.live) {
    const text = gate.message.replace('The bid that', 'The message that');
    await recordEvent(db, {
      orgId: message.org_id,
      type: 'external.blocked_by_live_mode',
      subjectTable: 'messages',
      subjectId: message.id,
      requestId,
      outcome: 'blocked',
      payload: {
        closedBy: gate.closedBy,
        wouldSend: {
          external_thread_id: message.external_thread_id,
          message: textFingerprint(message.body),
        },
      },
    });
    await note('blocked', { reason: 'live_mode_off', message: text, closedBy: gate.closedBy });
    return { status: 'blocked', reason: 'live_mode_off', message: text };
  }

  const fail = async (
    reason: 'no_account' | 'no_client' | 'refused',
    text: string,
  ): Promise<SendMessageResult> => {
    await db.query(`update messages set failure_reason = $2 where id = $1`, [message.id, text]);
    await note('error', { reason, message: text });
    return { status: 'failed', reason, message: text };
  };

  const accounts = await db.query<{ id: string }>(
    `select id from platform_accounts where org_id = $1 and platform = 'freelancer' and status = 'connected'`,
    [message.org_id],
  );
  const account = accounts.rows[0];
  if (!account)
    return fail(
      'no_account',
      'No Freelancer.com account is connected, so the message cannot be sent. Connect one in Settings and approve it again.',
    );
  if (!deps.config)
    return fail(
      'no_client',
      'Freelancer.com is not configured (docs/02 B-03), so the message cannot be sent.',
    );
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};
  let accessToken: string;
  try {
    accessToken = await freelancerAccessToken(
      { db, config: deps.config, ...fetchDeps, now: () => now },
      account.id,
    );
  } catch (error) {
    if (error instanceof AccountNotConnectedError) return fail('no_account', error.message);
    throw error;
  }

  try {
    const result = await postThreadMessage(
      deps.config,
      accessToken,
      message.external_thread_id,
      message.body,
      fetchDeps,
    );
    await recordEvent(db, {
      orgId: message.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId: message.id,
      requestId,
      outcome: 'ok',
      payload: {
        service: 'freelancer',
        call: SEND_MESSAGE_CALL,
        request_id: result.requestId,
        rate_limit: result.rateLimit,
      },
    });
    const sentAt = result.timeCreated ?? now;
    await db.query(
      `update messages set sent_at = $2, external_message_id = $3, failure_reason = null where id = $1`,
      [message.id, sentAt.toISOString(), result.id],
    );
    await db.query(
      `update threads set last_message_at = greatest(coalesce(last_message_at, $2), $2),
              status = case when status = 'closed' then status else 'awaiting_client' end where id = $1`,
      [message.thread_id, sentAt.toISOString()],
    );
    await note('ok', { external_message_id: result.id, sent_at: sentAt.toISOString() });
    return { status: 'sent', externalMessageId: result.id };
  } catch (error) {
    if (!(error instanceof FreelancerError)) throw error;
    await recordEvent(db, {
      orgId: message.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'messages',
      subjectId: message.id,
      requestId,
      outcome: 'error',
      payload: {
        service: 'freelancer',
        call: SEND_MESSAGE_CALL,
        status: error.status,
        error_code: error.errorCode,
        request_id: error.requestId,
        rate_limit: error.rateLimit ?? null,
      },
    });
    const final =
      error.isAuthFailure || (error.status >= 400 && error.status < 500 && !error.isRateLimited);
    if (final) {
      await fail('refused', `${error.message}. Edit the message and approve it again.`);
      throw new UnrecoverableError(error.message);
    }
    await note('error', { reason: 'retry', message: error.message, status: error.status });
    throw error;
  }
}

export function createSendMessageProcessor(deps: SendMessageDeps) {
  return (job: Job<SendMessageJobData>): Promise<SendMessageResult> => sendMessage(deps, job.data);
}

/** One send per message: BullMQ drops an add whose id is already queued. */
export function enqueueSendMessage(queue: Queue, data: SendMessageJobData) {
  return queue.add('send-message', data, { jobId: `send-message__${data.messageId}` });
}
