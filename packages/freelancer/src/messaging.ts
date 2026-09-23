import type { FreelancerConfig } from './config.js';
import {
  FreelancerError,
  readJson,
  readRateLimit,
  send,
  type Fetch,
  type RateLimit,
} from './http.js';

/**
 * The inbox (ARB-120): threads and their messages, read only. Both endpoints need the
 * `basic` scope and `fln:messaging` (advanced scope 5, asked for at connect, D-044).
 *
 * `GET /messages/0.1/threads/` — "Returns threads with the specified criteria"
 * (https://developers.freelancer.com/docs/messaging/threads, "List Threads"). Used here:
 * - `context_type` — `project`, `contest` or `general`.
 * - `from_updated_time` — "Return threads made after this time (Inclusive)", Unix seconds.
 * - `user_details` — projection, "Returns user information for each thread member".
 * - `context_details` — projection, "Returns context for each thread".
 * - `limit` and `offset` — pagination, at most 100 a page
 *   (https://developers.freelancer.com/docs/api-overview/making-a-request).
 *
 * `GET /messages/0.1/messages/` — "Returns a list of messages that match the given
 * query" (https://developers.freelancer.com/docs/messaging/messaging, "List Messages").
 * Used here: `threads[]` ("Returns messages with the specified thread IDs"),
 * `from_updated_time` (inclusive), `limit` and `offset`.
 *
 * Shapes, from the walkthrough (https://developers.freelancer.com/docs/use-cases/messaging):
 * a thread is `{ id, thread: { id, context: { type, id }, members: [ids], owner,
 * thread_type, time_created }, time_updated, time_read, is_read, is_muted, folder, … }`;
 * a message is `{ id, thread_id, from_user, message, time_created, parent_id,
 * attachments, … }`; the messages list answers `{ result: { messages: [...], threads,
 * users } }`. The docs page shows no example for the threads list; `result.threads`
 * follows every other list on the API (`result.projects`, `result.messages`) and is the
 * first thing to confirm against the sandbox (C-02). `users`, with `user_details`, is
 * read leniently as a map from user id to `{ username, display_name }`.
 */
export const MESSAGING_MAX_LIMIT = 100;

/**
 * `POST /messages/0.1/threads/{thread_id}/messages/` — "Adds a new message to an existing
 * thread" (https://developers.freelancer.com/docs/messaging/threads, "Create a Message";
 * scopes `basic` and `fln:messaging`). The reference page does not show the request
 * body; the walkthrough sends `message` as a URL parameter
 * (`POST …/threads/80000624/messages/?message=Hey there how are you?`,
 * https://developers.freelancer.com/docs/use-cases/messaging, "Making the Message
 * Request") and answers `{ status: "success", result: { id, thread_id, from_user,
 * message, time_created, … } }`. That is what is sent and read here; the sandbox run is
 * where the form is confirmed (C-02).
 */
export interface SentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly timeCreated: Date | null;
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

export type ThreadContextType = 'project' | 'contest' | 'general';

export interface ThreadQuery {
  readonly contextType?: ThreadContextType;
  readonly fromUpdatedTime?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MessageQuery {
  readonly threads: readonly string[];
  readonly fromUpdatedTime?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface FreelancerThread {
  readonly id: string;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly members: readonly string[];
  readonly owner: string | null;
  readonly threadType: string | null;
  readonly timeCreated: Date | null;
  readonly timeUpdated: Date | null;
  readonly isRead: boolean | null;
  readonly folder: string | null;
  readonly raw: Record<string, unknown>;
}

export interface FreelancerMessage {
  readonly id: string;
  readonly threadId: string;
  readonly fromUser: string | null;
  readonly message: string | null;
  readonly attachmentCount: number;
  readonly timeCreated: Date | null;
  readonly parentId: string | null;
  readonly raw: Record<string, unknown>;
}

export interface FreelancerUserDetail {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
}

export interface ThreadPage {
  readonly threads: readonly FreelancerThread[];
  readonly users: Readonly<Record<string, FreelancerUserDetail>>;
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

export interface MessagePage {
  readonly messages: readonly FreelancerMessage[];
  readonly requestId: string | null;
  readonly rateLimit: RateLimit;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const idText = (value: unknown): string | null =>
  typeof value === 'number' || typeof value === 'string' ? String(value) : null;
const seconds = (value: unknown): Date | null => {
  const n = num(value);
  return n === null ? null : new Date(n * 1000);
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const unixSeconds = (date: Date): string => String(Math.floor(date.getTime() / 1000));

export function threadsSearchParams(query: ThreadQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.contextType) params.set('context_type', query.contextType);
  if (query.fromUpdatedTime) params.set('from_updated_time', unixSeconds(query.fromUpdatedTime));
  params.set('user_details', 'true');
  params.set('context_details', 'true');
  params.set('limit', String(Math.min(query.limit ?? MESSAGING_MAX_LIMIT, MESSAGING_MAX_LIMIT)));
  if (query.offset) params.set('offset', String(query.offset));
  return params;
}

export function messagesSearchParams(query: MessageQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of query.threads) params.append('threads[]', id);
  if (query.fromUpdatedTime) params.set('from_updated_time', unixSeconds(query.fromUpdatedTime));
  params.set('limit', String(Math.min(query.limit ?? MESSAGING_MAX_LIMIT, MESSAGING_MAX_LIMIT)));
  if (query.offset) params.set('offset', String(query.offset));
  return params;
}

export function parseThread(raw: Record<string, unknown>): FreelancerThread | null {
  const inner = record(raw.thread);
  const id = idText(raw.id) ?? idText(inner.id);
  if (id === null) return null;
  const context = record(inner.context);
  const members = Array.isArray(inner.members) ? inner.members : [];
  return {
    id,
    contextType: str(context.type),
    contextId: idText(context.id),
    members: members.map(idText).filter((m): m is string => m !== null),
    owner: idText(inner.owner),
    threadType: str(inner.thread_type),
    timeCreated: seconds(inner.time_created),
    timeUpdated: seconds(raw.time_updated) ?? seconds(inner.time_updated),
    isRead: typeof raw.is_read === 'boolean' ? raw.is_read : null,
    folder: str(raw.folder),
    raw,
  };
}

export function parseMessage(raw: Record<string, unknown>): FreelancerMessage | null {
  const id = idText(raw.id);
  const threadId = idText(raw.thread_id);
  if (id === null || threadId === null) return null;
  return {
    id,
    threadId,
    fromUser: idText(raw.from_user),
    message: str(raw.message),
    attachmentCount: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
    timeCreated: seconds(raw.time_created),
    parentId: idText(raw.parent_id),
    raw,
  };
}

export function parseUsers(raw: unknown): Record<string, FreelancerUserDetail> {
  const users: Record<string, FreelancerUserDetail> = {};
  for (const [key, value] of Object.entries(record(raw))) {
    const user = record(value);
    const id = idText(user.id) ?? key;
    users[id] = { id, username: str(user.username), displayName: str(user.display_name) };
  }
  return users;
}

async function call(
  config: FreelancerConfig,
  accessToken: string,
  path: string,
  params: URLSearchParams,
  what: string,
  fetchImpl: Fetch,
): Promise<{ body: Record<string, unknown>; rateLimit: RateLimit; status: number }> {
  const response = await send(
    fetchImpl,
    `${config.apiUrl}${path}?${params.toString()}`,
    { method: 'GET', headers: { 'freelancer-oauth-v1': accessToken } },
    what,
  );
  const rateLimit = readRateLimit(response.headers);
  try {
    return { body: await readJson(response, what), rateLimit, status: response.status };
  } catch (error) {
    if (error instanceof FreelancerError) error.rateLimit = rateLimit;
    throw error;
  }
}

export async function listThreads(
  config: FreelancerConfig,
  accessToken: string,
  query: ThreadQuery,
  deps: { readonly fetch?: Fetch } = {},
): Promise<ThreadPage> {
  const what = 'the thread list';
  const { body, rateLimit, status } = await call(
    config,
    accessToken,
    '/messages/0.1/threads/',
    threadsSearchParams(query),
    what,
    deps.fetch ?? fetch,
  );
  const result = record(body.result);
  const list = Array.isArray(result.threads) ? result.threads : null;
  if (list === null) {
    throw new FreelancerError(
      'Freelancer.com answered the thread list without a threads list',
      status,
      null,
      str(body.request_id),
    );
  }
  return {
    threads: list
      .map((item) => parseThread(record(item)))
      .filter((thread): thread is FreelancerThread => thread !== null),
    users: parseUsers(result.users),
    requestId: str(body.request_id),
    rateLimit,
  };
}

export async function listMessages(
  config: FreelancerConfig,
  accessToken: string,
  query: MessageQuery,
  deps: { readonly fetch?: Fetch } = {},
): Promise<MessagePage> {
  const what = 'the message list';
  const { body, rateLimit, status } = await call(
    config,
    accessToken,
    '/messages/0.1/messages/',
    messagesSearchParams(query),
    what,
    deps.fetch ?? fetch,
  );
  const result = record(body.result);
  const list = Array.isArray(result.messages) ? result.messages : null;
  if (list === null) {
    throw new FreelancerError(
      'Freelancer.com answered the message list without a messages list',
      status,
      null,
      str(body.request_id),
    );
  }
  return {
    messages: list
      .map((item) => parseMessage(record(item)))
      .filter((message): message is FreelancerMessage => message !== null),
    requestId: str(body.request_id),
    rateLimit,
  };
}

export async function postThreadMessage(
  config: FreelancerConfig,
  accessToken: string,
  threadId: string,
  message: string,
  deps: { readonly fetch?: Fetch } = {},
): Promise<SentMessage> {
  const what = 'sending the message';
  const params = new URLSearchParams({ message });
  const response = await send(
    deps.fetch ?? fetch,
    `${config.apiUrl}/messages/0.1/threads/${encodeURIComponent(threadId)}/messages/?${params.toString()}`,
    { method: 'POST', headers: { 'freelancer-oauth-v1': accessToken } },
    what,
  );
  const rateLimit = readRateLimit(response.headers);
  let body: Record<string, unknown>;
  try {
    body = await readJson(response, what);
  } catch (error) {
    if (error instanceof FreelancerError) error.rateLimit = rateLimit;
    throw error;
  }
  const result = record(body.result);
  const id = idText(result.id);
  if (id === null) {
    throw new FreelancerError(
      'Freelancer.com answered the message without an id',
      response.status,
      null,
      str(body.request_id),
    );
  }
  return {
    id,
    threadId: idText(result.thread_id) ?? threadId,
    timeCreated: seconds(result.time_created),
    requestId: str(body.request_id),
    rateLimit,
  };
}
