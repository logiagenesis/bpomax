import { briefLockBlockers, type BriefInput } from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * Brief versions (ARB-131, docs/01 section F): one row per thread and version, the
 * current one unlocked until it is locked, and a change after that a new version. The
 * table's `locked_brief_is_complete` check is the last line under `lockBrief`.
 */
export interface BriefRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly version: number;
  readonly locked: boolean;
  readonly locked_at: string | null;
  readonly title: string;
  readonly outcome: string;
  readonly users: string | null;
  readonly must_haves: string[];
  readonly later: string[];
  readonly references_: string[];
  readonly assets_provided: string[];
  readonly assets_missing: string[];
  readonly tech_constraints: string[];
  readonly deadline: string | null;
  readonly deadline_fixed: boolean | null;
  readonly budget_min_minor: string | null;
  readonly budget_max_minor: string | null;
  readonly budget_currency: string | null;
  readonly budget_type: string | null;
  readonly acceptance_criteria: string[];
  readonly sign_off_name: string | null;
  readonly sign_off_response_time: string | null;
  readonly risks: string[];
  readonly category_slug: string | null;
  readonly delivery_route: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `id, org_id, thread_id, version, locked, locked_at, title, outcome, users, must_haves, later,
  references_, assets_provided, assets_missing, tech_constraints, deadline::text as deadline, deadline_fixed,
  budget_min_minor::text as budget_min_minor, budget_max_minor::text as budget_max_minor,
  budget_currency, budget_type::text as budget_type, acceptance_criteria, sign_off_name,
  sign_off_response_time, risks, category_slug, delivery_route::text as delivery_route, created_at, updated_at`;

const FIELDS = `title, outcome, users, must_haves, later, references_, assets_provided, assets_missing,
  tech_constraints, deadline, deadline_fixed, budget_min_minor, budget_max_minor, budget_currency,
  budget_type, acceptance_criteria, sign_off_name, sign_off_response_time, risks, category_slug, delivery_route`;

function values(input: BriefInput): unknown[] {
  return [
    input.title,
    input.outcome,
    input.users,
    input.mustHaves,
    input.later,
    input.references,
    input.assetsProvided,
    input.assetsMissing,
    input.techConstraints,
    input.deadline,
    input.deadlineFixed,
    input.budget.minMinor,
    input.budget.maxMinor,
    input.budget.currency,
    input.budget.type,
    input.acceptanceCriteria,
    input.signOff.name,
    input.signOff.responseTime,
    input.risks,
    input.category,
    input.deliveryRoute,
  ];
}

/** The row as a `BriefInput`, for validation and the lock rule. */
export function briefInputOf(row: BriefRow): BriefInput {
  return {
    title: row.title,
    outcome: row.outcome,
    users: row.users,
    mustHaves: row.must_haves,
    later: row.later,
    references: row.references_,
    assetsProvided: row.assets_provided,
    assetsMissing: row.assets_missing,
    techConstraints: row.tech_constraints,
    deadline: row.deadline,
    deadlineFixed: row.deadline_fixed,
    budget: {
      minMinor: row.budget_min_minor === null ? null : Number(row.budget_min_minor),
      maxMinor: row.budget_max_minor === null ? null : Number(row.budget_max_minor),
      currency: row.budget_currency?.trim() ?? null,
      type: (row.budget_type as BriefInput['budget']['type']) ?? null,
    },
    acceptanceCriteria: row.acceptance_criteria,
    signOff: { name: row.sign_off_name, responseTime: row.sign_off_response_time },
    risks: row.risks,
    category: row.category_slug,
    deliveryRoute: (row.delivery_route as BriefInput['deliveryRoute']) ?? null,
  };
}

export async function loadBrief(db: Queryable, id: string): Promise<BriefRow | null> {
  const { rows } = await db.query<BriefRow>(`select ${COLUMNS} from briefs where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The newest version on the thread. */
export async function loadCurrentBrief(db: Queryable, threadId: string): Promise<BriefRow | null> {
  const { rows } = await db.query<BriefRow>(
    `select ${COLUMNS} from briefs where thread_id = $1 order by version desc limit 1`,
    [threadId],
  );
  return rows[0] ?? null;
}

export async function listBriefVersions(db: Queryable, threadId: string): Promise<BriefRow[]> {
  const { rows } = await db.query<BriefRow>(
    `select ${COLUMNS} from briefs where thread_id = $1 order by version desc`,
    [threadId],
  );
  return rows;
}

/** Writes the next version on the thread (1 when there is none), unlocked. */
export async function insertBriefVersion(
  db: Queryable,
  input: { readonly orgId: string; readonly threadId: string; readonly brief: BriefInput },
): Promise<BriefRow> {
  const placeholders = values(input.brief).map((_, i) => `$${String(i + 3)}`);
  const { rows } = await db.query<BriefRow>(
    `insert into briefs (org_id, thread_id, version, ${FIELDS})
     select $1, $2, coalesce(max(version), 0) + 1, ${placeholders.join(', ')} from briefs where thread_id = $2
     returning ${COLUMNS}`,
    [input.orgId, input.threadId, ...values(input.brief)],
  );
  return rows[0]!;
}

/** Rewrites an unlocked version. Null when the row is missing or locked (the caller says which). */
export async function updateBrief(
  db: Queryable,
  id: string,
  brief: BriefInput,
): Promise<BriefRow | null> {
  const sets = FIELDS.split(',')
    .map((column) => column.trim())
    .map((column, i) => `${column} = $${String(i + 2)}`);
  const { rows } = await db.query<BriefRow>(
    `update briefs set ${sets.join(', ')} where id = $1 and not locked returning ${COLUMNS}`,
    [id, ...values(brief)],
  );
  return rows[0] ?? null;
}

export type LockOutcome =
  | { readonly ok: true; readonly brief: BriefRow }
  | { readonly ok: false; readonly missing: string[] };

/** Locks the version when it carries what a locked brief must; else says what is missing. */
export async function lockBrief(db: Queryable, row: BriefRow, now: Date): Promise<LockOutcome> {
  const missing = briefLockBlockers(briefInputOf(row));
  if (missing.length > 0) return { ok: false, missing };
  const { rows } = await db.query<BriefRow>(
    `update briefs set locked = true, locked_at = $2 where id = $1 and not locked returning ${COLUMNS}`,
    [row.id, now.toISOString()],
  );
  return rows[0] ? { ok: true, brief: rows[0] } : { ok: false, missing: ['an unlocked version'] };
}
