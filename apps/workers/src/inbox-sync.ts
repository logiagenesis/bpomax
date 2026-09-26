import { inTransaction, recordEvent, type Queryable } from '@arbitron/db';
import {
  AccountNotConnectedError,
  FreelancerError,
  freelancerAccessToken,
  listMessages,
  listThreads,
  type Fetch,
  type FreelancerConfig,
  type FreelancerMessage,
  type FreelancerThread,
  type FreelancerUserDetail,
} from '@arbitron/freelancer';
import type { Job, Queue } from 'bullmq';
import { enqueueAutoReply } from './auto-reply.js';
import { enqueueDiscovery } from './discovery.js';

/**
 * The inbox-sync worker (ARB-120, docs/01 section E): "interval — pulls new client
 * messages for connected accounts; stores; alerts operator". Two kinds of job run on the
 * `inbox-sync` queue, on the ingest worker's pattern (D-045, D-046):
 *
 * - `sync`, every minute from one fixed scheduler: keeps one job scheduler per connected
 *   Freelancer.com account, every two minutes, and removes the rest.
 * - `poll`, per account: the documented thread list for `project` threads updated since
 *   a little before the last run, then the documented message list for those threads
 *   (`@arbitron/freelancer`, `listThreads` and `listMessages`). Threads are upserted on
 *   their marketplace id and linked to the org's job by the thread's project context;
 *   messages are inserted once per marketplace id (0019). A message the account itself
 *   wrote on Freelancer.com is stored outbound with origin `platform`: observed, not
 *   sent by the app. Each new inbound message is a `message.received` event and an
 *   alert to the operator (the Telegram bot supplies the alert; the worker only calls
 *   it). The run is an `inbox.synced` event.
 *
 * A 429, a 5xx or a network failure is thrown back to the queue, whose backoff is the
 * wait. A refused token marks the account `expired` and is not retried.
 */
export const INBOX_SYNC_SCHEDULER_ID = 'inbox-sync';
export const INBOX_SYNC_EVERY_MS = 60_000;
/** How often each connected account's inbox is read. Two minutes: an interval, not a rush. */
export const INBOX_POLL_EVERY_MS = 120_000;
/** The thread list is asked from this long before the last run reached, so a late update is not missed. */
export const INBOX_LOOKBACK_MS = 5 * 60_000;
export const ACCOUNT_SCHEDULER_PREFIX = 'inbox:';
export const THREADS_CALL = 'messages/0.1/threads';
export const MESSAGES_CALL = 'messages/0.1/messages';
/** How many thread ids go into one message-list call. */
const THREADS_PER_MESSAGE_CALL = 20;
const MAX_PAGES = 10;

export type InboxJobData =
  | { readonly kind: 'sync' }
  | { readonly kind: 'poll'; readonly accountId: string; readonly requestId?: string };

export function accountSchedulerId(accountId: string): string {
  return `${ACCOUNT_SCHEDULER_PREFIX}${accountId}`;
}

export async function scheduleInboxSync(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    INBOX_SYNC_SCHEDULER_ID,
    { every: INBOX_SYNC_EVERY_MS },
    { name: 'sync', data: { kind: 'sync' } satisfies InboxJobData },
  );
}

/** What the operator is told about, once the message is stored. */
export interface InboundAlert {
  readonly orgId: string;
  readonly messageId: string;
  readonly threadId: string;
}

export interface InboxDeps {
  /** A service-role connection: the worker acts for whichever org owns the account. */
  readonly db: Queryable;
  readonly queue: Queue;
  readonly config: FreelancerConfig | null;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** Tells the operator; the Telegram bot's `notifyInbound`, wired by the process. */
  readonly alert?: (alert: InboundAlert) => Promise<unknown>;
  /** Where each new inbound message goes next: the auto-reply worker (ARB-121). */
  readonly autoReplyQueue?: Queue;
  /** And the discovery worker (ARB-130), which does nothing without a session. */
  readonly discoveryQueue?: Queue;
}

export interface InboxSync {
  readonly wanted: number;
  readonly added: number;
  readonly removed: number;
  readonly reason?: string;
}

export async function syncInboxSchedules(deps: InboxDeps): Promise<InboxSync> {
  const existing = new Set<string>();
  for (const scheduler of await deps.queue.getJobSchedulers()) {
    if (scheduler.key.startsWith(ACCOUNT_SCHEDULER_PREFIX)) existing.add(scheduler.key);
  }
  const wanted = new Set<string>();
  if (deps.config) {
    const { rows } = await deps.db.query<{ id: string }>(
      `select id from platform_accounts where platform = 'freelancer' and status = 'connected'`,
    );
    for (const row of rows) wanted.add(accountSchedulerId(row.id));
  }
  let added = 0;
  let removed = 0;
  for (const key of wanted) {
    if (existing.has(key)) continue;
    await deps.queue.upsertJobScheduler(
      key,
      { every: INBOX_POLL_EVERY_MS },
      {
        name: 'poll',
        data: {
          kind: 'poll',
          accountId: key.slice(ACCOUNT_SCHEDULER_PREFIX.length),
        } satisfies InboxJobData,
      },
    );
    added += 1;
  }
  for (const key of existing) {
    if (wanted.has(key)) continue;
    await deps.queue.removeJobScheduler(key);
    removed += 1;
  }
  return {
    wanted: wanted.size,
    added,
    removed,
    ...(deps.config ? {} : { reason: 'Freelancer.com is not configured (docs/02 B-03)' }),
  };
}

export type InboxRun =
  | {
      readonly status: 'polled';
      readonly accountId: string;
      readonly orgId: string;
      readonly threads: number;
      readonly newThreads: number;
      readonly messages: number;
      readonly newInbound: number;
      readonly newOutbound: number;
      readonly syncedTo: string | null;
    }
  | { readonly status: 'skipped'; readonly accountId: string; readonly reason: string }
  | {
      readonly status: 'auth_failed';
      readonly accountId: string;
      readonly orgId: string;
      readonly reason: string;
    };

interface AccountRow {
  id: string;
  org_id: string;
  status: string;
  external_user_id: string;
  inbox_synced_to: string | null;
}

interface ThreadRow {
  id: string;
  inserted: boolean;
}

/** The member who is not the account: the client, by username, display name, or id. */
export function clientHandle(
  thread: FreelancerThread,
  users: Readonly<Record<string, FreelancerUserDetail>>,
  ownId: string,
): string | null {
  const other = thread.members.find((member) => member !== ownId);
  if (other === undefined) return null;
  const user = users[other];
  return user?.username ?? user?.displayName ?? other;
}

/** What is stored for a message with no text: the docs show `attachments` as a list. */
export function messageBody(message: FreelancerMessage): string {
  if (message.message && message.message.trim()) return message.message;
  return message.attachmentCount > 0
    ? `(${String(message.attachmentCount)} attachment${message.attachmentCount === 1 ? '' : 's'}, not downloaded)`
    : '';
}

export async function pollInbox(
  deps: InboxDeps,
  data: { readonly accountId: string; readonly requestId?: string },
): Promise<InboxRun> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<AccountRow>(
    `select id, org_id, status::text as status, external_user_id, inbox_synced_to
       from platform_accounts where id = $1 and platform = 'freelancer'`,
    [data.accountId],
  );
  const account = rows[0];
  if (!account) {
    await deps.queue.removeJobScheduler(accountSchedulerId(data.accountId));
    return { status: 'skipped', accountId: data.accountId, reason: 'the account no longer exists' };
  }

  const synced = (
    outcome: 'ok' | 'error' | 'skipped',
    payload: Record<string, unknown>,
    on: Queryable = db,
  ): Promise<string> =>
    recordEvent(on, {
      orgId: account.org_id,
      type: 'inbox.synced',
      actorKind: 'system',
      subjectTable: 'platform_accounts',
      subjectId: account.id,
      requestId,
      outcome,
      payload,
    });
  const skip = async (reason: string): Promise<InboxRun> => {
    await synced('skipped', { reason });
    return { status: 'skipped', accountId: account.id, reason };
  };
  const externalCall = (
    call: string,
    outcome: 'ok' | 'error',
    detail: Record<string, unknown>,
  ): Promise<string> =>
    recordEvent(db, {
      orgId: account.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'platform_accounts',
      subjectId: account.id,
      requestId,
      outcome,
      payload: { service: 'freelancer', call, ...detail },
    });

  if (!deps.config) return skip('Freelancer.com is not configured (docs/02 B-03)');
  if (account.status !== 'connected') {
    await deps.queue.removeJobScheduler(accountSchedulerId(account.id));
    return skip(`the Freelancer.com account is ${account.status}; connect it again in Settings`);
  }
  const config = deps.config;
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};

  let accessToken: string;
  try {
    accessToken = await freelancerAccessToken(
      { db, config, ...fetchDeps, now: () => now },
      account.id,
    );
  } catch (error) {
    if (error instanceof AccountNotConnectedError) return skip(error.message);
    if (error instanceof FreelancerError)
      await synced('error', { reason: error.message, retry: true });
    throw error;
  }

  const refused = async (call: string, error: FreelancerError): Promise<InboxRun> => {
    await externalCall(call, 'error', {
      status: error.status,
      error_code: error.errorCode,
      request_id: error.requestId,
      rate_limit: error.rateLimit ?? null,
    });
    if (error.isAuthFailure) {
      await db.query(`update platform_accounts set status = 'expired' where id = $1`, [account.id]);
      const reason =
        'Freelancer.com refused the token, so the account is marked expired. Connect it again in Settings.';
      await synced('error', { reason, status: error.status, error_code: error.errorCode });
      return { status: 'auth_failed', accountId: account.id, orgId: account.org_id, reason };
    }
    await synced('error', {
      reason: error.message,
      status: error.status,
      error_code: error.errorCode,
      retry: true,
    });
    throw error;
  };

  // 1. Threads updated since a little before the last run, in pages.
  const since = account.inbox_synced_to
    ? new Date(new Date(account.inbox_synced_to).getTime() - INBOX_LOOKBACK_MS)
    : undefined;
  const threads: FreelancerThread[] = [];
  const users: Record<string, FreelancerUserDetail> = {};
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await listThreads(
        config,
        accessToken,
        {
          contextType: 'project',
          ...(since ? { fromUpdatedTime: since } : {}),
          limit: 100,
          offset: page * 100,
        },
        fetchDeps,
      );
    } catch (error) {
      if (error instanceof FreelancerError) return refused(THREADS_CALL, error);
      throw error;
    }
    await externalCall(THREADS_CALL, 'ok', {
      request_id: result.requestId,
      returned: result.threads.length,
      rate_limit: result.rateLimit,
    });
    threads.push(...result.threads);
    Object.assign(users, result.users);
    if (result.threads.length < 100) break;
  }

  // 2. Their messages, in batches of thread ids.
  const messages: FreelancerMessage[] = [];
  for (let i = 0; i < threads.length; i += THREADS_PER_MESSAGE_CALL) {
    const batch = threads.slice(i, i + THREADS_PER_MESSAGE_CALL).map((thread) => thread.id);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let result;
      try {
        result = await listMessages(
          config,
          accessToken,
          {
            threads: batch,
            ...(since ? { fromUpdatedTime: since } : {}),
            limit: 100,
            offset: page * 100,
          },
          fetchDeps,
        );
      } catch (error) {
        if (error instanceof FreelancerError) return refused(MESSAGES_CALL, error);
        throw error;
      }
      await externalCall(MESSAGES_CALL, 'ok', {
        request_id: result.requestId,
        returned: result.messages.length,
        rate_limit: result.rateLimit,
      });
      messages.push(...result.messages);
      if (result.messages.length < 100) break;
    }
  }

  // 3. Store, oldest message first so a thread's status ends on its newest one.
  const alerts: InboundAlert[] = [];
  let newThreads = 0;
  let newInbound = 0;
  let newOutbound = 0;
  let syncedTo: Date | null = account.inbox_synced_to ? new Date(account.inbox_synced_to) : null;
  await inTransaction(db, async (tx) => {
    const threadIds = new Map<string, string>();
    const handles = new Map<string, string | null>();
    for (const thread of threads) {
      const job = thread.contextId
        ? await tx.query<{ id: string }>(
            `select id from jobs where org_id = $1 and platform = 'freelancer' and external_id = $2`,
            [account.org_id, thread.contextId],
          )
        : null;
      const handle = clientHandle(thread, users, account.external_user_id);
      // A thread is the org's own (0037, the owner's audit P-06). A thread the retention
      // job has redacted keeps its handle removed: listing it again is not a reason to
      // hold the client's name again (P-05); a new message is, below.
      const upserted = await tx.query<ThreadRow>(
        `insert into threads (org_id, job_id, platform, external_thread_id, client_handle)
         values ($1, $2, 'freelancer', $3, $4)
         on conflict (org_id, platform, external_thread_id) do update
           set job_id = coalesce(threads.job_id, excluded.job_id),
               client_handle = case when threads.redacted_at is not null then null
                                    else coalesce(excluded.client_handle, threads.client_handle) end
         returning id, (xmax = 0) as inserted`,
        [account.org_id, job?.rows[0]?.id ?? null, thread.id, handle],
      );
      const row = upserted.rows[0]!;
      threadIds.set(thread.id, row.id);
      handles.set(row.id, handle);
      if (row.inserted) newThreads += 1;
      if (thread.timeUpdated && (!syncedTo || thread.timeUpdated > syncedTo)) {
        syncedTo = thread.timeUpdated;
      }
    }

    const ordered = [...messages].sort(
      (a, b) => (a.timeCreated?.getTime() ?? 0) - (b.timeCreated?.getTime() ?? 0),
    );
    for (const message of ordered) {
      const threadId = threadIds.get(message.threadId);
      if (!threadId) continue;
      const inbound = message.fromUser !== account.external_user_id;
      const { rows: inserted } = await tx.query<{ id: string }>(
        `insert into messages
           (org_id, thread_id, direction, body, sent_at, external_message_id, origin)
         values ($1, $2, $3, $4, $5, $6, 'platform')
         on conflict (thread_id, external_message_id) where external_message_id is not null
           do nothing
         returning id`,
        [
          account.org_id,
          threadId,
          inbound ? 'in' : 'out',
          messageBody(message),
          message.timeCreated?.toISOString() ?? null,
          message.id,
        ],
      );
      const row = inserted[0];
      if (!row) continue;
      if (inbound) newInbound += 1;
      else newOutbound += 1;
      // A new message is new activity: the thread is open again, even if it had been
      // closed or redacted (the owner's audit P-01, P-05). What was redacted stays
      // redacted; the new message, and the handle it came with, start a new retention
      // period, so the retention job redacts them in their turn.
      await tx.query(
        `update threads
            set last_message_at = greatest(coalesce(last_message_at, $2), $2),
                status = $3::thread_status,
                redacted_at = null,
                client_handle = coalesce(client_handle, $4)
          where id = $1`,
        [
          threadId,
          message.timeCreated?.toISOString() ?? now.toISOString(),
          inbound ? 'awaiting_operator' : 'awaiting_client',
          handles.get(threadId) ?? null,
        ],
      );
      if (inbound) {
        await recordEvent(tx, {
          orgId: account.org_id,
          type: 'message.received',
          actorKind: 'system',
          subjectTable: 'messages',
          subjectId: row.id,
          requestId,
          outcome: 'ok',
          payload: {
            thread_id: threadId,
            external_thread_id: message.threadId,
            external_message_id: message.id,
            // Not the client's platform user id: an identifier of theirs the retention
            // job could never reach here (P-02).
            sent_at: message.timeCreated?.toISOString() ?? null,
          },
        });
        alerts.push({ orgId: account.org_id, messageId: row.id, threadId });
      }
    }

    await tx.query(
      `update platform_accounts set inbox_synced_to = $2, last_sync_at = $3 where id = $1`,
      [account.id, syncedTo?.toISOString() ?? null, now.toISOString()],
    );
    await synced(
      'ok',
      {
        threads: threads.length,
        new_threads: newThreads,
        messages: messages.length,
        new_inbound: newInbound,
        new_outbound: newOutbound,
        synced_to: syncedTo?.toISOString() ?? null,
      },
      tx,
    );
  });

  // 4. After the commit, so the operator's link opens a stored message and the auto-reply
  //    worker finds the row.
  for (const alert of alerts) {
    if (deps.autoReplyQueue) {
      await enqueueAutoReply(deps.autoReplyQueue, {
        messageId: alert.messageId,
        ...(requestId ? { requestId } : {}),
      });
    }
    if (deps.discoveryQueue) {
      await enqueueDiscovery(deps.discoveryQueue, {
        messageId: alert.messageId,
        ...(requestId ? { requestId } : {}),
      });
    }
    if (deps.alert) await deps.alert(alert);
  }

  return {
    status: 'polled',
    accountId: account.id,
    orgId: account.org_id,
    threads: threads.length,
    newThreads,
    messages: messages.length,
    newInbound,
    newOutbound,
    syncedTo: syncedTo?.toISOString() ?? null,
  };
}

/** The processor for the `inbox-sync` queue: the sync, or one account's poll. */
export function inboxProcessor(deps: InboxDeps) {
  return async (job: Job<InboxJobData>): Promise<InboxSync | InboxRun> => {
    if (job.data.kind === 'sync') return syncInboxSchedules(deps);
    return pollInbox(deps, {
      accountId: job.data.accountId,
      ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
    });
  };
}
