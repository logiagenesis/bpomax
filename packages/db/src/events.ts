import {
  assertActorIsConsistent,
  assertEventType,
  type EventInput,
  type EventOutcome,
  type EventType,
} from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * The audit log writer and reader (ARB-014, docs/01 section D).
 *
 * `events` is append-only in the database: migration 0007 rewrites away updates and
 * deletes, and 0008 gives the table select and insert policies and no others. Nothing
 * here can rewrite history even by accident, which is the point.
 */
export interface EventRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_user_id: string | null;
  readonly actor_kind: string;
  readonly type: string;
  readonly subject_table: string | null;
  readonly subject_id: string | null;
  readonly request_id: string | null;
  readonly outcome: string | null;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

/** Writes one event. The type is checked against the vocabulary before it is stored. */
export async function recordEvent(db: Queryable, event: EventInput): Promise<string> {
  assertEventType(event.type);
  assertActorIsConsistent(event);

  const actorKind = event.actorKind ?? (event.actorUserId ? 'user' : 'system');
  const { rows } = await db.query<{ id: string }>(
    `insert into events
       (org_id, actor_user_id, actor_kind, type, subject_table, subject_id, request_id, outcome, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning id`,
    [
      event.orgId,
      event.actorUserId ?? null,
      actorKind,
      event.type,
      event.subjectTable ?? null,
      event.subjectId ?? null,
      event.requestId ?? null,
      event.outcome ?? 'ok',
      JSON.stringify(event.payload ?? {}),
    ],
  );

  const id = rows[0]?.id;
  if (!id) {
    // RLS returning no row is a refusal, not an empty result. Surfacing it as an error
    // stops a caller from believing an action was recorded when it was not.
    throw new Error(`event "${event.type}" was not recorded; the write was refused`);
  }
  return id;
}

export interface EventFilters {
  readonly type?: EventType | readonly EventType[];
  readonly actorUserId?: string;
  readonly subjectTable?: string;
  readonly subjectId?: string;
  readonly outcome?: EventOutcome;
  /** Inclusive lower bound, ISO 8601. */
  readonly from?: string;
  /** Exclusive upper bound, ISO 8601. */
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export const EVENTS_PAGE_LIMIT = 100;

/**
 * Reads the log newest first. There is no org_id parameter on purpose — RLS scopes the
 * result to whoever is signed in, so a missing filter cannot widen the answer.
 */
export async function listEvents(db: Queryable, filters: EventFilters = {}): Promise<EventRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${String(params.length)}`));
  };

  if (filters.type) {
    const types = Array.isArray(filters.type) ? filters.type : [filters.type];
    for (const type of types) assertEventType(type);
    add('type = any(?)', types);
  }
  if (filters.actorUserId) add('actor_user_id = ?', filters.actorUserId);
  if (filters.subjectTable) add('subject_table = ?', filters.subjectTable);
  if (filters.subjectId) add('subject_id = ?', filters.subjectId);
  if (filters.outcome) add('outcome = ?', filters.outcome);
  if (filters.from) add('created_at >= ?', filters.from);
  if (filters.to) add('created_at < ?', filters.to);

  const limit = Math.min(Math.max(filters.limit ?? EVENTS_PAGE_LIMIT, 1), EVENTS_PAGE_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);

  const { rows } = await db.query<EventRow>(
    `select id, org_id, actor_user_id, actor_kind, type, subject_table, subject_id,
            request_id, outcome, payload, created_at
     from events
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by created_at desc, id desc
     limit $${String(params.length - 1)} offset $${String(params.length)}`,
    params,
  );
  return rows;
}

/** Every event written while serving one request, oldest first. */
export async function listEventsForRequest(db: Queryable, requestId: string): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `select id, org_id, actor_user_id, actor_kind, type, subject_table, subject_id,
            request_id, outcome, payload, created_at
     from events where request_id = $1 order by created_at asc, id asc`,
    [requestId],
  );
  return rows;
}

export interface EventActor {
  readonly id: string;
  /** Null when the caller cannot see that user's row; the page then shows the id. */
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * Everyone who appears as an actor in the caller's audit log, for the actor filter
 * (ARB-062). Scoped by RLS like `listEvents`: only events the caller can read count.
 */
export async function listEventActors(db: Queryable): Promise<EventActor[]> {
  const { rows } = await db.query<EventActor>(
    `select a.actor_user_id as id, u.full_name as name, u.email
     from (select distinct actor_user_id from events where actor_user_id is not null) a
     left join users u on u.id = a.actor_user_id
     order by coalesce(u.full_name, u.email, a.actor_user_id::text)`,
  );
  return rows;
}
