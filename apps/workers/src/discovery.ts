import {
  DISCOVERY_EXTRACT_SCHEMA,
  DISCOVERY_EXTRACT_SYSTEM_PROMPT,
  acceptedDiscoveryAnswers,
  buildDiscoveryExtractPrompt,
  openQuestions,
  type ModelDiscoveryExtraction,
} from '@arbitron/core';
import {
  captureDiscoveryAnswers,
  draftDiscoveryBatch,
  loadDiscoverySession,
  recordEvent,
  recordLlmCall,
  type Queryable,
} from '@arbitron/db';
import { LlmOutputError, completeJson, type LlmTransport } from '@arbitron/llm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';

/**
 * The discovery worker (ARB-130, docs/01 section E): "client replied — drafts the next
 * discovery question set for approval; updates completeness". One job per new inbound
 * message, queued by the inbox sync. With no session on the thread it does nothing: a
 * session is started by the operator (the API). With one, the model reads the reply
 * against the open questions (strict JSON, one retry, D-049), only confident readings
 * of open questions are written as answers, completeness is recomputed, and, while any
 * question is open, the next batch is drafted as an unapproved outbound message on the
 * thread. Nothing here sends anything (ARB-122).
 */
export interface DiscoveryJobData {
  readonly messageId: string;
  readonly requestId?: string;
}

export interface DiscoveryDeps {
  /** A service-role connection: the worker acts for whichever org owns the thread. */
  readonly db: Queryable;
  readonly transport: LlmTransport;
  readonly model: string;
  readonly now?: () => Date;
}

export type DiscoveryResult =
  | { readonly status: 'skipped'; readonly reason: 'no_session' | 'not_inbound' | 'complete' }
  | {
      readonly status: 'updated';
      readonly sessionId: string;
      readonly completeness: number;
      readonly captured: string[];
      readonly draftedMessageId: string | null;
      readonly draftedKeys: string[];
    };

interface InboundRow {
  id: string;
  org_id: string;
  thread_id: string;
  direction: string;
  body: string;
  client_handle: string | null;
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

export async function runDiscovery(
  deps: DiscoveryDeps,
  data: DiscoveryJobData,
): Promise<DiscoveryResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<InboundRow>(
    `select m.id, m.org_id, m.thread_id, m.direction::text as direction, m.body, t.client_handle
       from messages m join threads t on t.id = m.thread_id where m.id = $1`,
    [data.messageId],
  );
  const message = rows[0];
  if (!message) throw new UnrecoverableError(`message ${data.messageId} does not exist`);
  if (message.direction !== 'in') return { status: 'skipped', reason: 'not_inbound' };
  const session = await loadDiscoverySession(db, message.thread_id);
  if (!session) return { status: 'skipped', reason: 'no_session' };
  const open = openQuestions(session.answers);
  if (open.length === 0) return { status: 'skipped', reason: 'complete' };

  let result;
  try {
    result = await completeJson<ModelDiscoveryExtraction>({
      transport: deps.transport,
      model: deps.model,
      schema: DISCOVERY_EXTRACT_SCHEMA,
      system: DISCOVERY_EXTRACT_SYSTEM_PROMPT,
      prompt: buildDiscoveryExtractPrompt({ questions: open, reply: message.body }),
      retries: 1,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      await inTransaction(db, async () => {
        await recordLlmCall(db, {
          orgId: message.org_id,
          purpose: 'discovery',
          model: deps.model,
          subjectTable: 'discovery_sessions',
          subjectId: session.id,
          requestId,
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          costNanoUsd: error.costNanoUsd,
          attempts: error.attempts,
          outcome: 'invalid_output',
          problems: error.problems,
        });
        await recordEvent(db, {
          orgId: message.org_id,
          type: 'discovery.updated',
          subjectTable: 'discovery_sessions',
          subjectId: session.id,
          requestId,
          outcome: 'error',
          payload: {
            reason: 'invalid_output',
            attempts: error.attempts,
            problems: error.problems,
            message_id: message.id,
          },
        });
      });
      throw new UnrecoverableError(`discovery session ${session.id}: ${error.message}`);
    }
    await recordEvent(db, {
      orgId: message.org_id,
      type: 'discovery.updated',
      subjectTable: 'discovery_sessions',
      subjectId: session.id,
      requestId,
      outcome: 'error',
      payload: { reason: 'transport', message: (error as Error).message, message_id: message.id },
    });
    throw error;
  }

  const accepted = acceptedDiscoveryAnswers(result.value, session.answers);
  return inTransaction(db, async () => {
    await recordLlmCall(db, {
      orgId: message.org_id,
      purpose: 'discovery',
      model: result.model,
      subjectTable: 'discovery_sessions',
      subjectId: session.id,
      requestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens ?? 0,
      cacheWriteTokens:
        (result.usage.cacheWrite5mTokens ?? 0) + (result.usage.cacheWrite1hTokens ?? 0),
      costNanoUsd: result.costNanoUsd,
      attempts: result.attempts,
      outcome: 'ok',
      problems: result.problems,
    });
    const captured = await captureDiscoveryAnswers(db, session, accepted, 'client', now);
    const draft = await draftDiscoveryBatch(db, captured.session, {
      clientHandle: message.client_handle,
      now,
    });
    await recordEvent(db, {
      orgId: message.org_id,
      type: 'discovery.updated',
      subjectTable: 'discovery_sessions',
      subjectId: session.id,
      requestId,
      outcome: 'ok',
      payload: {
        message_id: message.id,
        captured: captured.captured,
        completeness: Number(captured.session.completeness),
        drafted_message_id: draft?.messageId ?? null,
        drafted: draft?.keys ?? [],
      },
    });
    if (draft) {
      await recordEvent(db, {
        orgId: message.org_id,
        type: 'message.drafted',
        subjectTable: 'messages',
        subjectId: draft.messageId,
        requestId,
        payload: { via: 'discovery', thread_id: message.thread_id, questions: draft.keys },
      });
    }
    return {
      status: 'updated',
      sessionId: session.id,
      completeness: Number(captured.session.completeness),
      captured: captured.captured,
      draftedMessageId: draft?.messageId ?? null,
      draftedKeys: draft?.keys ?? [],
    };
  });
}

export function createDiscoveryProcessor(deps: DiscoveryDeps) {
  return (job: Job<DiscoveryJobData>): Promise<DiscoveryResult> => runDiscovery(deps, job.data);
}

/** One job per inbound message: BullMQ drops an add whose id is already queued. */
export function enqueueDiscovery(queue: Queue, data: DiscoveryJobData) {
  return queue.add('discovery', data, { jobId: `discovery__${data.messageId}` });
}
