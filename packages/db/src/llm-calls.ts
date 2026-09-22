import type { Queryable } from './client.js';

/**
 * Per-call LLM metering (ARB-031).
 *
 * Deliberately decoupled from `@arbitron/llm`: this package stores what it is given and
 * knows nothing about providers. Cost is in whole nano-US-dollars — see migration 0011
 * for why cents would not do.
 */
export type LlmPurpose = 'score' | 'draft' | 'discovery' | 'brief' | 'estimate' | 'other';
export type LlmCallOutcome = 'ok' | 'invalid_output' | 'error';

export interface LlmCallInput {
  readonly orgId: string;
  readonly purpose: LlmPurpose;
  readonly model: string;
  readonly subjectTable?: string | null;
  readonly subjectId?: string | null;
  readonly requestId?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costNanoUsd?: number;
  readonly attempts?: number;
  readonly outcome?: LlmCallOutcome;
  /** Validator complaints only. Never the prompt or the reply — those carry client content. */
  readonly problems?: readonly (readonly string[])[];
}

export interface LlmCallRow {
  readonly id: string;
  readonly org_id: string;
  readonly purpose: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_nano_usd: number;
  readonly attempts: number;
  readonly outcome: string;
  readonly created_at: string;
}

export async function recordLlmCall(db: Queryable, call: LlmCallInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into llm_calls
       (org_id, purpose, model, subject_table, subject_id, request_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_nano_usd, attempts, outcome, problems)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     returning id`,
    [
      call.orgId,
      call.purpose,
      call.model,
      call.subjectTable ?? null,
      call.subjectId ?? null,
      call.requestId ?? null,
      call.inputTokens ?? 0,
      call.outputTokens ?? 0,
      call.cacheReadTokens ?? 0,
      call.cacheWriteTokens ?? 0,
      call.costNanoUsd ?? 0,
      call.attempts ?? 1,
      call.outcome ?? 'ok',
      JSON.stringify(call.problems ?? []),
    ],
  );

  const id = rows[0]?.id;
  if (!id) throw new Error('the LLM call was not metered; the write was refused');
  return id;
}

export interface SpendSummary {
  readonly purpose: string;
  readonly model: string;
  readonly calls: number;
  readonly costNanoUsd: number;
}

/** What has been spent, scoped by RLS to the caller's org. */
export async function summariseSpend(
  db: Queryable,
  range: { from?: string; to?: string } = {},
): Promise<SpendSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (range.from) {
    params.push(range.from);
    where.push(`created_at >= $${String(params.length)}`);
  }
  if (range.to) {
    params.push(range.to);
    where.push(`created_at < $${String(params.length)}`);
  }

  const { rows } = await db.query<{
    purpose: string;
    model: string;
    calls: string;
    cost_nano_usd: string;
  }>(
    `select purpose, model, count(*)::text as calls, coalesce(sum(cost_nano_usd), 0)::text as cost_nano_usd
     from llm_calls
     ${where.length ? `where ${where.join(' and ')}` : ''}
     group by purpose, model
     order by purpose, model`,
    params,
  );

  return rows.map((row) => ({
    purpose: row.purpose,
    model: row.model,
    calls: Number(row.calls),
    costNanoUsd: Number(row.cost_nano_usd),
  }));
}
