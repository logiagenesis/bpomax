import {
  DISCOVERY_QUESTION_SET_VERSION,
  discoveryCompleteness,
  mergeDiscoveryAnswers,
  nextDiscoveryBatch,
  renderDiscoveryBatch,
  type DiscoveryAnswerSource,
  type DiscoveryAnswers,
  type DiscoveryAsked,
} from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * Discovery sessions (ARB-130, docs/01 section F): one per thread and question-set
 * version. Shared by the API (the operator starts a session, captures answers by hand,
 * asks for the next batch) and the discovery worker (a client's reply read into
 * answers, the next batch drafted). Callers write the events; these write the rows.
 */
export interface DiscoverySessionRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly question_set_version: string;
  readonly answers: DiscoveryAnswers;
  readonly asked: DiscoveryAsked;
  readonly completeness: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  'id, org_id, thread_id, question_set_version, answers, asked, completeness::text as completeness, created_at, updated_at';

export async function loadDiscoverySession(
  db: Queryable,
  threadId: string,
): Promise<DiscoverySessionRow | null> {
  const { rows } = await db.query<DiscoverySessionRow>(
    `select ${COLUMNS} from discovery_sessions where thread_id = $1 order by question_set_version desc, created_at desc limit 1`,
    [threadId],
  );
  return rows[0] ?? null;
}

export async function startDiscoverySession(
  db: Queryable,
  input: { readonly orgId: string; readonly threadId: string },
): Promise<DiscoverySessionRow> {
  const { rows } = await db.query<DiscoverySessionRow>(
    `insert into discovery_sessions (org_id, thread_id, question_set_version)
     values ($1, $2, $3) returning ${COLUMNS}`,
    [input.orgId, input.threadId, DISCOVERY_QUESTION_SET_VERSION],
  );
  return rows[0]!;
}

/** Merges answers in, recomputes completeness, and returns the row and the keys that were new. */
export async function captureDiscoveryAnswers(
  db: Queryable,
  session: DiscoverySessionRow,
  incoming: Readonly<Record<string, string>>,
  source: DiscoveryAnswerSource,
  now: Date,
): Promise<{ readonly session: DiscoverySessionRow; readonly captured: string[] }> {
  const merged = mergeDiscoveryAnswers(session.answers, incoming, source, now);
  const captured = Object.keys(incoming).filter(
    (key) => merged[key] !== undefined && session.answers[key] === undefined,
  );
  const { rows } = await db.query<DiscoverySessionRow>(
    `update discovery_sessions set answers = $2::jsonb, completeness = $3 where id = $1 returning ${COLUMNS}`,
    [session.id, JSON.stringify(merged), discoveryCompleteness(merged)],
  );
  return { session: rows[0]!, captured };
}

export interface DiscoveryDraft {
  readonly messageId: string;
  readonly keys: string[];
  readonly body: string;
  readonly session: DiscoverySessionRow;
}

/**
 * Drafts the next batch as an unsent, unapproved outbound message on the thread
 * (ARB-122's rules: nothing leaves without a person), and records the questions as
 * asked. Null when nothing is open.
 */
export async function draftDiscoveryBatch(
  db: Queryable,
  session: DiscoverySessionRow,
  input: { readonly clientHandle: string | null; readonly now: Date },
): Promise<DiscoveryDraft | null> {
  const batch = nextDiscoveryBatch(session.answers, session.asked);
  if (batch.length === 0) return null;
  const body = renderDiscoveryBatch(batch, input.clientHandle);
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body, origin)
     values ($1, $2, 'out', $3, 'app') returning id`,
    [session.org_id, session.thread_id, body],
  );
  const asked: Record<string, string> = { ...session.asked };
  for (const question of batch) asked[question.key] = input.now.toISOString();
  const updated = await db.query<DiscoverySessionRow>(
    `update discovery_sessions set asked = $2::jsonb where id = $1 returning ${COLUMNS}`,
    [session.id, JSON.stringify(asked)],
  );
  return { messageId: rows[0]!.id, keys: batch.map((q) => q.key), body, session: updated.rows[0]! };
}
