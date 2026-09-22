import Anthropic from '@anthropic-ai/sdk';
import type { LlmRequest, LlmResponse, LlmTransport } from './transport.js';

/**
 * The Anthropic transport (ARB-031).
 *
 * UNVERIFIED: no call has ever been made, because there is no API key (docs/02 B-08,
 * docs/BLOCKERS.md V-04). Everything around it — schema validation, the retry, the
 * metering — is tested against a fake transport, so this file is deliberately thin:
 * build the request, stream it, hand back the text and the usage.
 *
 * Streaming rather than a plain create: a long draft with a high `max_tokens` is exactly
 * the shape of request that hits a request timeout, and `finalMessage()` costs nothing
 * extra when the reply is short.
 */
export class AnthropicTransport implements LlmTransport {
  private readonly client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set (docs/02-BLOCKERS.md B-08)');
    }
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async send(request: LlmRequest): Promise<LlmResponse> {
    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.system ? { system: request.system } : {}),
      ...(request.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: [{ role: 'user', content: request.prompt }],
    });

    const message = await stream.finalMessage();

    // Thinking blocks are not the answer; only text blocks are.
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model: message.model,
      stopReason: message.stop_reason ?? undefined,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite5mTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
