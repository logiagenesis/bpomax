import {
  BRIEF_BUILD_SCHEMA,
  BRIEF_BUILD_SYSTEM_PROMPT,
  DISCOVERY_QUESTIONS,
  briefFromDiscovery,
  briefFromModel,
  briefLockBlockers,
  buildBriefPrompt,
  validateBrief,
  type ModelBrief,
} from '@arbitron/core';
import {
  insertBriefVersion,
  loadCurrentBrief,
  loadDiscoverySession,
  recordEvent,
  recordLlmCall,
  type Queryable,
} from '@arbitron/db';
import { LlmOutputError, completeJson, type LlmTransport } from '@arbitron/llm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';

/**
 * The brief-build worker (ARB-131, docs/01 section E): "discovery ≥ threshold —
 * produces structured brief; operator locks it". One job per thread, queued by the
 * discovery worker when completeness reaches `BRIEF_BUILD_THRESHOLD` (D-050). It drafts
 * version 1 only: with a brief already on the thread it does nothing, so a person's
 * edits are never overwritten. The model structures the answers (strict JSON, one
 * retry) over the hand draft; the result is validated as any brief is, and stored
 * unlocked with what a lock still needs in the event. Locking is the operator's.
 */
export const BRIEF_BUILD_THRESHOLD = 70;

export interface BriefBuildJobData {
  readonly threadId: string;
  readonly requestId?: string;
}

export interface BriefBuildDeps {
  /** A service-role connection: the worker acts for whichever org owns the thread. */
  readonly db: Queryable;
  readonly transport: LlmTransport;
  readonly model: string;
  readonly now?: () => Date;
}

export type BriefBuildResult =
  | { readonly status: 'skipped'; readonly reason: 'no_session' | 'below_threshold' | 'exists' }
  | { readonly status: 'drafted'; readonly briefId: string; readonly lockBlockers: string[] };

interface ThreadRow {
  id: string;
  org_id: string;
  job_title: string | null;
}

async function inTransaction<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const result = await work();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

export async function buildBrief(
  deps: BriefBuildDeps,
  data: BriefBuildJobData,
): Promise<BriefBuildResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<ThreadRow>(
    `select t.id, t.org_id, j.title as job_title from threads t left join jobs j on j.id = t.job_id where t.id = $1`,
    [data.threadId],
  );
  const thread = rows[0];
  if (!thread) throw new UnrecoverableError(`thread ${data.threadId} does not exist`);
  const session = await loadDiscoverySession(db, thread.id);
  if (!session) return { status: 'skipped', reason: 'no_session' };
  if (Number(session.completeness) < BRIEF_BUILD_THRESHOLD)
    return { status: 'skipped', reason: 'below_threshold' };
  if (await loadCurrentBrief(db, thread.id)) return { status: 'skipped', reason: 'exists' };

  const base = briefFromDiscovery(session.answers, thread.job_title);
  let result;
  try {
    result = await completeJson<ModelBrief>({
      transport: deps.transport,
      model: deps.model,
      schema: BRIEF_BUILD_SCHEMA,
      system: BRIEF_BUILD_SYSTEM_PROMPT,
      prompt: buildBriefPrompt({
        jobTitle: thread.job_title,
        questions: DISCOVERY_QUESTIONS,
        answers: session.answers,
        today: now.toISOString().slice(0, 10),
      }),
      retries: 1,
      maxTokens: 4096,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      await inTransaction(db, async () => {
        await recordLlmCall(db, {
          orgId: thread.org_id,
          purpose: 'brief',
          model: deps.model,
          subjectTable: 'threads',
          subjectId: thread.id,
          requestId,
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          costNanoUsd: error.costNanoUsd,
          attempts: error.attempts,
          outcome: 'invalid_output',
          problems: error.problems,
        });
        await recordEvent(db, {
          orgId: thread.org_id,
          type: 'brief.drafted',
          subjectTable: 'threads',
          subjectId: thread.id,
          requestId,
          outcome: 'error',
          payload: { reason: 'invalid_output', attempts: error.attempts, problems: error.problems },
        });
      });
      throw new UnrecoverableError(`thread ${thread.id}: ${error.message}`);
    }
    await recordEvent(db, {
      orgId: thread.org_id,
      type: 'brief.drafted',
      subjectTable: 'threads',
      subjectId: thread.id,
      requestId,
      outcome: 'error',
      payload: { reason: 'transport', message: (error as Error).message },
    });
    throw error;
  }

  const candidate = briefFromModel(result.value, base);
  const validated = validateBrief(candidate);
  // The model's structure is held to the same rule as a person's; a bad field falls back to the hand draft.
  const brief = validated.ok ? validated.value : base;
  return inTransaction(db, async () => {
    await recordLlmCall(db, {
      orgId: thread.org_id,
      purpose: 'brief',
      model: result.model,
      subjectTable: 'threads',
      subjectId: thread.id,
      requestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens ?? 0,
      cacheWriteTokens:
        (result.usage.cacheWrite5mTokens ?? 0) + (result.usage.cacheWrite1hTokens ?? 0),
      costNanoUsd: result.costNanoUsd,
      attempts: result.attempts,
      outcome: 'ok',
      problems: validated.ok
        ? result.problems
        : [...result.problems, validated.errors.map((e) => `${e.field} ${e.message}`)],
    });
    const row = await insertBriefVersion(db, { orgId: thread.org_id, threadId: thread.id, brief });
    const lockBlockers = briefLockBlockers(brief);
    await recordEvent(db, {
      orgId: thread.org_id,
      type: 'brief.drafted',
      subjectTable: 'briefs',
      subjectId: row.id,
      requestId,
      outcome: 'ok',
      payload: {
        via: 'model',
        version: row.version,
        completeness: Number(session.completeness),
        lock_blockers: lockBlockers,
        model_used: validated.ok,
      },
    });
    return { status: 'drafted', briefId: row.id, lockBlockers };
  });
}

export function createBriefBuildProcessor(deps: BriefBuildDeps) {
  return (job: Job<BriefBuildJobData>): Promise<BriefBuildResult> => buildBrief(deps, job.data);
}

/** One draft per thread: BullMQ drops an add whose id is already queued. */
export function enqueueBriefBuild(queue: Queue, data: BriefBuildJobData) {
  return queue.add('brief-build', data, { jobId: `brief-build__${data.threadId}` });
}
