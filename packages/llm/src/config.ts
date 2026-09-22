import { isPricedModel, PRICES_SOURCE } from './pricing.js';

/**
 * LLM configuration (ARB-031, docs/01 section C).
 *
 * Model names are configuration, never hard-coded. A model with no price in the table is
 * refused at startup rather than metered at zero for the rest of its life.
 */
export interface LlmConfig {
  readonly apiKey: string;
  readonly scoreModel: string;
  readonly draftModel: string;
  readonly baseUrl?: string;
}

export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
}

export type LlmConfigResult =
  | { readonly ok: true; readonly config: LlmConfig }
  | { readonly ok: false; readonly problems: ConfigProblem[] };

export function readLlmConfig(env: Record<string, string | undefined>): LlmConfigResult {
  const problems: ConfigProblem[] = [];

  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    problems.push({
      variable: 'ANTHROPIC_API_KEY',
      message: 'is not set (docs/02-BLOCKERS.md B-08)',
    });
  }

  const models: Record<'scoreModel' | 'draftModel', string> = {
    scoreModel: env.LLM_MODEL_SCORE ?? '',
    draftModel: env.LLM_MODEL_DRAFT ?? '',
  };

  for (const [key, variable] of [
    ['scoreModel', 'LLM_MODEL_SCORE'],
    ['draftModel', 'LLM_MODEL_DRAFT'],
  ] as const) {
    const model = models[key];
    if (!model) {
      problems.push({ variable, message: 'is not set' });
    } else if (!isPricedModel(model)) {
      problems.push({
        variable,
        message: `names "${model}", which has no price in MODEL_PRICES. Add it from ${PRICES_SOURCE} first.`,
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const baseUrl = env.ANTHROPIC_BASE_URL;
  return {
    ok: true,
    config: {
      apiKey,
      scoreModel: models.scoreModel,
      draftModel: models.draftModel,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}
