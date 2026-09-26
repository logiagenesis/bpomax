import type { Queryable } from './client.js';
import { recordEvent } from './events.js';

/**
 * The retention job (ARB-015, docs/02 T-06).
 *
 * Runs as service_role: it works across every org, so it deliberately sits outside row
 * level security. It redacts rather than deletes — the client's words and handle go, the
 * rows stay — because deleting a thread would cascade into the pipeline, the payments
 * and the audit log, and an audit log with holes in it is not one.
 *
 * With no retention period set, the job stands down and says so. It never picks a
 * period, because the period is a legal answer, not a default.
 */
export const REDACTED_TEXT = '[redacted: retention period elapsed]';

export interface RetentionResult {
  readonly orgId: string;
  readonly status: 'purged' | 'skipped_no_period';
  readonly retentionDays: number | null;
  readonly cutoff: string | null;
  /** Conversations closed this run for having been idle the whole period (P-01). */
  readonly closedIdle: number;
  readonly threads: number;
  readonly messages: number;
  readonly discoverySessions: number;
}

interface OrgRetentionRow {
  readonly org_id: string;
  readonly retention_days: number | null;
}

/** One org. `now` is injectable so the tests are not at the mercy of the clock. */
export async function purgeOrg(
  db: Queryable,
  orgId: string,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const settings = await db.query<OrgRetentionRow>(
    `select org_id, retention_days from settings where org_id = $1`,
    [orgId],
  );
  const retentionDays = settings.rows[0]?.retention_days ?? null;

  if (retentionDays === null) {
    await recordEvent(db, {
      orgId,
      type: 'retention.purged',
      outcome: 'skipped',
      payload: { reason: 'no retention period set; see docs/02-BLOCKERS.md T-06' },
    });
    return {
      orgId,
      status: 'skipped_no_period',
      retentionDays: null,
      cutoff: null,
      closedIdle: 0,
      threads: 0,
      messages: 0,
      discoverySessions: 0,
    };
  }

  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();

  // A conversation closes when it has had no activity for the whole retention period and
  // no contract rides on it: its job is not won, in delivery or delivered-but-unpaid (the
  // owner's audit P-01; before this nothing ever closed one, so nothing was ever
  // redacted). A new message opens it again (inbox sync). What counts as still necessary
  // is the T-06 adviser's to confirm (D-076).
  const openWork = `exists (
      select 1 from pipeline_items p
       where p.org_id = t.org_id and p.job_id = t.job_id
         and p.stage in ('won', 'in_delivery', 'delivered'))`;
  const closed = await db.query<{ id: string }>(
    `update threads t
        set status = 'closed'
      where t.org_id = $1
        and t.redacted_at is null
        and t.status <> 'closed'
        and coalesce(t.last_message_at, t.created_at) < $2
        and not ${openWork}
      returning t.id`,
    [orgId, cutoff],
  );

  // Only closed conversations, and only ones with no activity since the cutoff. A thread
  // still open is still necessary, whatever its age.
  const threads = await db.query<{ id: string }>(
    `update threads t
        set redacted_at = $2, client_handle = null
      where t.org_id = $1
        and t.redacted_at is null
        and t.status = 'closed'
        and coalesce(t.last_message_at, t.created_at) < $3
        and not ${openWork}
      returning t.id`,
    [orgId, now.toISOString(), cutoff],
  );
  const threadIds = threads.rows.map((row) => row.id);

  if (threadIds.length === 0) {
    await recordEvent(db, {
      orgId,
      type: 'retention.purged',
      outcome: 'ok',
      payload: {
        retention_days: retentionDays,
        cutoff,
        closed_idle: closed.rows.length,
        threads: 0,
        messages: 0,
      },
    });
    return {
      orgId,
      status: 'purged',
      retentionDays,
      cutoff,
      closedIdle: closed.rows.length,
      threads: 0,
      messages: 0,
      discoverySessions: 0,
    };
  }

  const messages = await db.query(
    `update messages set body = $2, redacted_at = $3
      where org_id = $1 and thread_id = any($4) and redacted_at is null
      returning id`,
    [orgId, REDACTED_TEXT, now.toISOString(), threadIds],
  );

  const sessions = await db.query(
    `update discovery_sessions set answers = '{}'::jsonb, redacted_at = $2
      where org_id = $1 and thread_id = any($3) and redacted_at is null
      returning id`,
    [orgId, now.toISOString(), threadIds],
  );

  const result: RetentionResult = {
    orgId,
    status: 'purged',
    retentionDays,
    cutoff,
    closedIdle: closed.rows.length,
    threads: threadIds.length,
    messages: messages.rows.length,
    discoverySessions: sessions.rows.length,
  };

  await recordEvent(db, {
    orgId,
    type: 'retention.purged',
    outcome: 'ok',
    payload: {
      retention_days: retentionDays,
      cutoff,
      closed_idle: closed.rows.length,
      threads: result.threads,
      messages: result.messages,
      discovery_sessions: result.discoverySessions,
    },
  });

  return result;
}

/** Every org, for the scheduled run. */
export async function purgeAll(db: Queryable, now: Date = new Date()): Promise<RetentionResult[]> {
  const { rows } = await db.query<{ id: string }>('select id from orgs order by id');
  const results: RetentionResult[] = [];
  for (const org of rows) {
    results.push(await purgeOrg(db, org.id, now));
  }
  return results;
}
