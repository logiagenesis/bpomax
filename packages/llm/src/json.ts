import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { addUsage, costNanoUsd, emptyUsage, type TokenUsage } from './cost.js';
import type { LlmTransport } from './transport.js';

/**
 * A model call that must come back as JSON matching a schema (ARB-031).
 *
 * Models are asked for structure and sometimes return prose, a fenced block, or JSON
 * that is the right shape but the wrong types. Rather than let any of that through, the
 * output is parsed and validated; a failure is retried **once**, with the specific
 * validation errors fed back, and a second failure is an error rather than a guess.
 *
 * Both attempts are metered. A wasted call still cost money, and a cost figure that
 * quietly omits retries understates exactly the calls worth knowing about.
 */
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: object): ValidateFunction {
  const existing = compiled.get(schema);
  if (existing) return existing;
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
}

export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly problems: string[][],
    readonly lastText: string,
    readonly usage: TokenUsage,
    readonly costNanoUsd: number,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

/** Pulls JSON out of a reply that may be fenced or have a sentence wrapped round it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error('the reply contained no JSON that would parse');
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) =>
    `${error.instancePath || '(root)'} ${error.message ?? ''}`.trim(),
  );
}

export interface CompleteJsonOptions {
  readonly transport: LlmTransport;
  readonly model: string;
  readonly schema: object;
  readonly prompt: string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly thinking?: boolean;
  readonly temperature?: number;
  /** Extra attempts after the first. The spec asks for one (01 section E). */
  readonly retries?: number;
  readonly batch?: boolean;
}

export interface LlmJsonResult<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly costNanoUsd: number;
  /** 1 when the first reply was good, 2 when the retry saved it. */
  readonly attempts: number;
  readonly model: string;
  /** What was wrong with each attempt that failed. Empty when the first reply was good. */
  readonly problems: string[][];
}

export async function completeJson<T>(options: CompleteJsonOptions): Promise<LlmJsonResult<T>> {
  const validate = validatorFor(options.schema);
  const retries = options.retries ?? 1;
  const maxTokens = options.maxTokens ?? 2048;

  let usage = emptyUsage();
  const problems: string[][] = [];
  let lastText = '';
  let prompt = options.prompt;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const response = await options.transport.send({
      model: options.model,
      prompt,
      maxTokens,
      ...(options.system ? { system: options.system } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    usage = addUsage(usage, response.usage);
    lastText = response.text;

    let parsed: unknown;
    const attemptProblems: string[] = [];

    if (response.stopReason === 'max_tokens') {
      // Truncated JSON sometimes still parses into a shorter, wrong object, so this is
      // called out rather than left to the schema to maybe catch.
      attemptProblems.push('the reply was cut off at max_tokens');
    }

    if (attemptProblems.length === 0) {
      try {
        parsed = extractJson(response.text);
      } catch (error) {
        attemptProblems.push((error as Error).message);
      }
    }

    if (attemptProblems.length === 0) {
      if (validate(parsed)) {
        return {
          value: parsed as T,
          usage,
          costNanoUsd: costNanoUsd(options.model, usage, { batch: options.batch ?? false }),
          attempts: attempt,
          model: options.model,
          problems,
        };
      }
      attemptProblems.push(...describe(validate.errors));
    }

    problems.push(attemptProblems);

    prompt =
      `${options.prompt}\n\n` +
      `Your previous reply was rejected. Return only JSON matching the schema, with no ` +
      `commentary and no code fence.\n\n` +
      `Previous reply:\n${response.text}\n\n` +
      `What was wrong:\n${attemptProblems.map((p) => `- ${p}`).join('\n')}`;
  }

  const cost = costNanoUsd(options.model, usage, { batch: options.batch ?? false });
  throw new LlmOutputError(
    `the model did not return valid JSON after ${String(retries + 1)} attempts`,
    retries + 1,
    problems,
    lastText,
    usage,
    cost,
  );
}
