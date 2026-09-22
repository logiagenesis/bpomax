import { describe, expect, it } from 'vitest';
import { NANO_PER_USD, type TokenUsage } from './cost.js';
import { LlmOutputError, completeJson, extractJson } from './json.js';
import type { LlmRequest, LlmResponse, LlmTransport } from './transport.js';

/**
 * ARB-031 acceptance: invalid model output is rejected and retried once, and the cost is
 * recorded per call — including the cost of the attempt that was thrown away.
 */
const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['go', 'caution', 'skip'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

const USAGE: TokenUsage = { inputTokens: 1_000, outputTokens: 500 };

/** Replies from a script, and remembers what it was asked. */
class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly replies: (string | Partial<LlmResponse>)[]) {}

  send(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (reply === undefined) {
      throw new Error(`the transport was called ${String(this.requests.length)} times, unscripted`);
    }
    const partial = typeof reply === 'string' ? { text: reply } : reply;
    return Promise.resolve({
      text: '',
      model: request.model,
      usage: USAGE,
      ...partial,
    });
  }
}

describe('pulling JSON out of a reply', () => {
  it('takes it plain', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('takes it out of a code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('takes it out from under a sentence', () => {
    expect(extractJson('Here is the result:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('takes an array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('says so when there is none', () => {
    expect(() => extractJson('I am afraid I cannot do that.')).toThrow(/no JSON/i);
  });
});

describe('a good first reply', () => {
  it('is returned without a retry', async () => {
    const transport = new ScriptedTransport(['{"score":72,"verdict":"go"}']);
    const result = await completeJson<{ score: number }>({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });

    expect(result.value).toEqual({ score: 72, verdict: 'go' });
    expect(result.attempts).toBe(1);
    expect(result.problems).toEqual([]);
    expect(transport.requests).toHaveLength(1);
  });

  it('is costed from the published price', async () => {
    const transport = new ScriptedTransport(['{"score":72,"verdict":"go"}']);
    const result = await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });
    // 1,000 in at $5/MTok and 500 out at $25/MTok.
    expect(result.costNanoUsd).toBe(17_500_000);
    expect(result.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 500 });
  });
});

describe('a reply that does not match the schema', () => {
  it('is retried exactly once, and the retry is accepted', async () => {
    const transport = new ScriptedTransport([
      '{"score":"very good","verdict":"go"}',
      '{"score":72,"verdict":"go"}',
    ]);
    const result = await completeJson<{ score: number }>({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });

    expect(result.attempts).toBe(2);
    expect(result.value).toEqual({ score: 72, verdict: 'go' });
    expect(transport.requests).toHaveLength(2);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.join(' ')).toMatch(/score/);
  });

  it('charges for both attempts, not just the one that worked', async () => {
    const transport = new ScriptedTransport([
      'not json at all',
      '{"score":50,"verdict":"caution"}',
    ]);
    const result = await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });

    expect(result.usage.inputTokens).toBe(2_000);
    expect(result.usage.outputTokens).toBe(1_000);
    expect(result.costNanoUsd).toBe(35_000_000);
  });

  it('tells the model what was wrong rather than just asking again', async () => {
    const transport = new ScriptedTransport(['{"verdict":"go"}', '{"score":10,"verdict":"skip"}']);
    await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });

    const retry = transport.requests[1]?.prompt ?? '';
    expect(retry).toContain('Score this job.');
    expect(retry).toMatch(/was rejected/i);
    expect(retry).toMatch(/score/);
    expect(retry).toContain('{"verdict":"go"}');
  });

  it('gives up after the retry instead of looping', async () => {
    const transport = new ScriptedTransport([
      '{"score":-1,"verdict":"go"}',
      '{"score":-2,"verdict":"go"}',
      '{"score":50,"verdict":"go"}',
    ]);

    await expect(
      completeJson({
        transport,
        model: 'claude-opus-5',
        schema: SCORE_SCHEMA,
        prompt: 'Score this job.',
      }),
    ).rejects.toThrow(LlmOutputError);

    expect(transport.requests).toHaveLength(2);
  });

  it('carries the wasted cost on the failure, so it is still metered', async () => {
    const transport = new ScriptedTransport(['nope', 'still nope']);
    try {
      await completeJson({
        transport,
        model: 'claude-opus-5',
        schema: SCORE_SCHEMA,
        prompt: 'Score this job.',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as LlmOutputError;
      expect(failure.attempts).toBe(2);
      expect(failure.problems).toHaveLength(2);
      expect(failure.costNanoUsd).toBe(35_000_000);
      expect(failure.lastText).toBe('still nope');
    }
  });

  it('refuses an extra property the schema did not ask for', async () => {
    const transport = new ScriptedTransport([
      '{"score":72,"verdict":"go","clientEmail":"someone@example.test"}',
      '{"score":72,"verdict":"go"}',
    ]);
    const result = await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });
    expect(result.attempts).toBe(2);
    expect(result.value).toEqual({ score: 72, verdict: 'go' });
  });
});

describe('a reply that was cut off', () => {
  it('is rejected even though the truncated JSON happens to parse', async () => {
    const transport = new ScriptedTransport([
      { text: '{"score":72,"verdict":"go"}', stopReason: 'max_tokens' },
      '{"score":72,"verdict":"go","reasons":["clear brief"]}',
    ]);
    const result = await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });

    expect(result.attempts).toBe(2);
    expect(result.problems[0]?.[0]).toMatch(/cut off/i);
  });
});

describe('the retry budget', () => {
  it('can be turned off for a call that must not be paid for twice', async () => {
    const transport = new ScriptedTransport(['garbage', '{"score":1,"verdict":"skip"}']);
    await expect(
      completeJson({
        transport,
        model: 'claude-opus-5',
        schema: SCORE_SCHEMA,
        prompt: 'Score this job.',
        retries: 0,
      }),
    ).rejects.toThrow(LlmOutputError);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('the request the transport receives', () => {
  it('carries the model, the prompt and the token ceiling', async () => {
    const transport = new ScriptedTransport(['{"score":1,"verdict":"skip"}']);
    await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
      system: 'You score jobs.',
      maxTokens: 512,
      thinking: true,
    });

    expect(transport.requests[0]).toMatchObject({
      model: 'claude-opus-5',
      system: 'You score jobs.',
      maxTokens: 512,
      thinking: true,
    });
  });

  it('defaults the ceiling rather than leaving it to the provider', async () => {
    const transport = new ScriptedTransport(['{"score":1,"verdict":"skip"}']);
    await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
    });
    expect(transport.requests[0]?.maxTokens).toBe(2048);
  });
});

describe('batch pricing', () => {
  it('halves the recorded cost', async () => {
    const transport = new ScriptedTransport(['{"score":72,"verdict":"go"}']);
    const result = await completeJson({
      transport,
      model: 'claude-opus-5',
      schema: SCORE_SCHEMA,
      prompt: 'Score this job.',
      batch: true,
    });
    expect(result.costNanoUsd).toBe(8_750_000);
    expect(result.costNanoUsd / NANO_PER_USD).toBeCloseTo(0.00875, 8);
  });
});
