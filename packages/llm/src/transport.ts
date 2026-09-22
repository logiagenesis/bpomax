import type { TokenUsage } from './cost.js';

/**
 * The provider boundary (ARB-031, docs/01 section C).
 *
 * Everything above this line is provider-agnostic and fully tested. The Anthropic
 * implementation is the only part that needs a real key, so it is kept as small and as
 * obvious as it can be (docs/BLOCKERS.md V-04).
 */
export interface LlmRequest {
  readonly model: string;
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens: number;
  /**
   * Adaptive thinking, for judgement calls like scoring. Off for pure extraction, where
   * it buys nothing and costs output tokens.
   */
  readonly thinking?: boolean;
  readonly temperature?: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  /** `max_tokens` means the JSON is probably truncated, which is worth knowing. */
  readonly stopReason?: string;
}

export interface LlmTransport {
  send(request: LlmRequest): Promise<LlmResponse>;
}
