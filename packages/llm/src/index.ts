/**
 * @arbitron/llm — provider-agnostic LLM client (ARB-031).
 *
 * Model names and prices are read from config, never hard-coded (01 section C).
 * Prices come from the published Anthropic pricing page; see pricing.ts for the source
 * and the date they were read.
 */
export * from './anthropic.js';
export * from './config.js';
export * from './cost.js';
export * from './json.js';
export * from './pricing.js';
export * from './transport.js';

export const PACKAGE_NAME = '@arbitron/llm';
