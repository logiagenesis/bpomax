import type { Queryable } from './client.js';
import { recordEvent } from './events.js';

/**
 * Data subject access and erasure (ARB-521, the owner's audit P-04).
 *
 * Two kinds of person are held here: the people who use the app (owners, operators,
 * viewers) and the marketplace clients whose conversations the inbox stores. Each can ask
 * what is held about them; a client can ask for their conversation to be erased.
 *
 * What names a person who uses the app is found from the database itself, every foreign
 * key to `users`, so a table added later is in the export from the day it exists (the
 * test holds the list). Deleting or anonymising a person or an org is D-17, the owner's
 * decision, and is not built here.
 */
export const ERASED_TEXT = '[redacted: erased on request]';

export interface PersonColumn {
  readonly table: string;
  readonly column: string;
}

/** Every column in `public` that names a person: a foreign key to `users`. */
export async function personColumns(db: Queryable): Promise<PersonColumn[]> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `select cl.relname as table_name, a.attname as column_name
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'public.users'::regclass and n.nspname = 'public'
      order by 1, 2`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

export interface PersonExport {
  readonly person: Record<string, unknown> | null;
  readonly memberships: readonly Record<string, unknown>[];
  /**
   * Every row naming the person, by `table.column`: what they did and when. For the audit
   * log, the whole event (its payload holds ids and fingerprints, never client text,
   * D-076); for the rest, the row's id and times, without the content the row also holds
   * about others (a client's bid, a link code).
   */
  readonly namedIn: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Everything held about the person with this `users.id`. Run it as that person
 * (`withUser`): row-level security then limits it to what they may see, which is their
 * own rows in their own organisations.
 */
export async function exportPerson(db: Queryable, userId: string): Promise<PersonExport> {
  const person = await db.query<Record<string, unknown>>(
    `select id, email, full_name, telegram_chat_id is not null as telegram_linked,
            created_at, updated_at
       from users where id = $1`,
    [userId],
  );
  const memberships = await db.query<Record<string, unknown>>(
    `select m.org_id, o.name as org_name, m.role::text as role, m.created_at
       from memberships m join orgs o on o.id = m.org_id
      where m.user_id = $1 order by m.created_at`,
    [userId],
  );
  const namedIn: Record<string, Record<string, unknown>[]> = {};
  for (const { table, column } of await personColumns(db)) {
    if (table === 'memberships') continue;
    const columns =
      table === 'events'
        ? 'id, org_id, type, actor_kind, subject_table, subject_id, request_id, outcome, payload, created_at'
        : 'id, created_at';
    const { rows } = await db.query<Record<string, unknown>>(
      `select ${columns} from ${q(table)} where ${q(column)} = $1 order by created_at`,
      [userId],
    );
    namedIn[`${table}.${column}`] = rows;
  }
  return { person: person.rows[0] ?? null, memberships: memberships.rows, namedIn };
}

export interface ClientExport {
  readonly handle: string;
  readonly threads: readonly Record<string, unknown>[];
  readonly messages: readonly Record<string, unknown>[];
  readonly discoverySessions: readonly Record<string, unknown>[];
  readonly briefs: readonly Record<string, unknown>[];
}

async function clientThreads(db: Queryable, orgId: string, handle: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select id from threads where org_id = $1 and lower(client_handle) = lower($2) order by created_at`,
    [orgId, handle],
  );
  return rows.map((r) => r.id);
}

/** Everything an org holds about a marketplace client, by the handle they use there. */
export async function exportClient(
  db: Queryable,
  orgId: string,
  handle: string,
): Promise<ClientExport> {
  const ids = await clientThreads(db, orgId, handle);
  const byThread = async (sql: string) =>
    ids.length === 0 ? [] : (await db.query<Record<string, unknown>>(sql, [ids])).rows;
  return {
    handle,
    threads: await byThread(
      `select id, platform::text as platform, external_thread_id, client_handle, status::text as status,
              last_message_at, created_at from threads where id = any($1) order by created_at`,
    ),
    messages: await byThread(
      `select id, thread_id, direction::text as direction, body, sent_at, created_at
         from messages where thread_id = any($1) order by coalesce(sent_at, created_at)`,
    ),
    discoverySessions: await byThread(
      `select id, thread_id, answers, created_at from discovery_sessions
        where thread_id = any($1) order by created_at`,
    ),
    briefs: await byThread(
      `select * from briefs where thread_id = any($1) order by thread_id, version`,
    ),
  };
}

export interface ClientErasure {
  readonly threads: number;
  readonly messages: number;
  readonly discoverySessions: number;
}

/**
 * Erases a client's conversations in this org, as the retention job redacts them (D-040):
 * their handle, their messages' words and their discovery answers go; the rows stay, so
 * the pipeline, payments and audit log stay whole, and the audit log holds none of their
 * words (D-076). Briefs are kept, as retention keeps them, until the T-06 adviser says
 * otherwise. A later message from them opens a new conversation (D-076).
 */
export async function eraseClient(
  db: Queryable,
  input: {
    readonly orgId: string;
    readonly handle: string;
    readonly actorUserId: string;
    readonly requestId?: string | null;
    readonly now?: Date;
  },
): Promise<ClientErasure> {
  const now = (input.now ?? new Date()).toISOString();
  const ids = await clientThreads(db, input.orgId, input.handle);
  let messages = 0;
  let sessions = 0;
  if (ids.length > 0) {
    await db.query(
      `update threads set client_handle = null, redacted_at = $2, status = 'closed' where id = any($1)`,
      [ids, now],
    );
    messages =
      (
        await db.query(
          `update messages set body = $2, redacted_at = $3 where thread_id = any($1) and redacted_at is null`,
          [ids, ERASED_TEXT, now],
        )
      ).affectedRows ?? 0;
    sessions =
      (
        await db.query(
          `update discovery_sessions set answers = '{}'::jsonb, redacted_at = $2
            where thread_id = any($1) and redacted_at is null`,
          [ids, now],
        )
      ).affectedRows ?? 0;
  }
  await recordEvent(db, {
    orgId: input.orgId,
    type: 'privacy.erased',
    actorUserId: input.actorUserId,
    requestId: input.requestId ?? null,
    outcome: ids.length > 0 ? 'ok' : 'skipped',
    // Counts only: the handle is what was erased.
    payload: { threads: ids.length, messages, discovery_sessions: sessions },
  });
  return { threads: ids.length, messages, discoverySessions: sessions };
}
