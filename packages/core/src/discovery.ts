import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Discovery (ARB-130, docs/01 section F): the question set, versioned here, "asked in
 * small batches, never all at once"; the answers captured so far; and the completeness
 * that follows from them. The ten questions are section F's, in its order and words.
 * A client's reply is read into answers by the model against `DISCOVERY_EXTRACT_SCHEMA`;
 * the batch put to the client is a template the operator edits and approves (D-049).
 */
export const DISCOVERY_QUESTION_SET_VERSION = '1';

export interface DiscoveryQuestion {
  readonly key: string;
  readonly text: string;
}

export const DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = [
  { key: 'outcome', text: 'What is the end result you need, in one sentence?' },
  { key: 'users', text: 'Who uses it (you, your staff, your customers)?' },
  { key: 'day_one', text: 'What must it do on day one? What can wait?' },
  { key: 'references', text: 'Do you have examples you like (links, screenshots)?' },
  { key: 'assets', text: 'Existing assets: domain, hosting, logins, brand files, content, data?' },
  { key: 'tech', text: 'Technology constraints or preferences?' },
  { key: 'deadline', text: 'Deadline, and is it fixed?' },
  { key: 'budget', text: 'Budget range, and fixed or hourly?' },
  { key: 'acceptance', text: 'How will you judge that it is finished (acceptance)?' },
  { key: 'sign_off', text: 'Who signs off, and how fast can they respond?' },
];

const KEYS = new Set(DISCOVERY_QUESTIONS.map((q) => q.key));

/** Three at a time: few enough to answer in one reply, and never the whole set. */
export const DISCOVERY_BATCH_SIZE = 3;
export const MAX_DISCOVERY_ANSWER_LENGTH = 2000;
/** Below this the model's reading of a reply is not written as an answer. */
export const DISCOVERY_MIN_CONFIDENCE = 0.6;

export type DiscoveryAnswerSource = 'client' | 'operator';

export interface DiscoveryAnswer {
  readonly answer: string;
  readonly source: DiscoveryAnswerSource;
  readonly capturedAt: string;
}

/** By question key. */
export type DiscoveryAnswers = Readonly<Record<string, DiscoveryAnswer>>;
/** By question key: when it was last put to the client. */
export type DiscoveryAsked = Readonly<Record<string, string>>;

/** Answered questions as a percentage of the set, to two decimals. */
export function discoveryCompleteness(answers: DiscoveryAnswers): number {
  const answered = DISCOVERY_QUESTIONS.filter((q) => answers[q.key] !== undefined).length;
  return Math.round((answered / DISCOVERY_QUESTIONS.length) * 10_000) / 100;
}

export function openQuestions(answers: DiscoveryAnswers): DiscoveryQuestion[] {
  return DISCOVERY_QUESTIONS.filter((q) => answers[q.key] === undefined);
}

/**
 * The next questions to put to the client: the open ones, those never asked first, at
 * most `batchSize` and always fewer than the whole set.
 */
export function nextDiscoveryBatch(
  answers: DiscoveryAnswers,
  asked: DiscoveryAsked,
  batchSize: number = DISCOVERY_BATCH_SIZE,
): DiscoveryQuestion[] {
  const open = openQuestions(answers);
  const size = Math.max(1, Math.min(batchSize, DISCOVERY_QUESTIONS.length - 1));
  const never = open.filter((q) => asked[q.key] === undefined);
  const again = open.filter((q) => asked[q.key] !== undefined);
  return [...never, ...again].slice(0, size);
}

/** The draft the operator sees on the approvals page: a greeting, the questions numbered, nothing more. */
export function renderDiscoveryBatch(
  questions: readonly DiscoveryQuestion[],
  clientHandle: string | null,
): string {
  const lines = [
    `Hi${clientHandle ? ` ${clientHandle}` : ''}, thanks for your message. A few questions so I can scope this properly:`,
    '',
    ...questions.map((q, i) => `${String(i + 1)}. ${q.text}`),
    '',
    'Short answers are fine.',
  ];
  return lines.join('\n');
}

export function validateDiscoveryAnswers(input: unknown): ValidationResult<Record<string, string>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'answers', message: 'must be an object' }] };
  }
  const raw = (input as { answers?: unknown }).answers;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ field: 'answers', message: 'must be an object of question keys to answers' }],
    };
  }
  const errors: FieldError[] = [];
  const value: Record<string, string> = {};
  for (const [key, text] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.has(key)) {
      errors.push({ field: `answers.${key}`, message: 'is not a question in this set' });
      continue;
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      errors.push({ field: `answers.${key}`, message: 'must not be empty' });
    } else if (text.trim().length > MAX_DISCOVERY_ANSWER_LENGTH) {
      errors.push({
        field: `answers.${key}`,
        message: `must be ${String(MAX_DISCOVERY_ANSWER_LENGTH)} characters or fewer`,
      });
    } else value[key] = text.trim();
  }
  if (Object.keys(value).length === 0 && errors.length === 0) {
    errors.push({ field: 'answers', message: 'must hold at least one answer' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

export function mergeDiscoveryAnswers(
  existing: DiscoveryAnswers,
  incoming: Readonly<Record<string, string>>,
  source: DiscoveryAnswerSource,
  at: Date,
): DiscoveryAnswers {
  const merged: Record<string, DiscoveryAnswer> = { ...existing };
  for (const [key, answer] of Object.entries(incoming)) {
    if (!KEYS.has(key)) continue;
    merged[key] = { answer, source, capturedAt: at.toISOString() };
  }
  return merged;
}

// ----------------------------------------------------------------- the model

export interface ModelDiscoveryExtraction {
  readonly answers: readonly {
    readonly key: string;
    readonly answer: string;
    readonly confidence: number;
  }[];
}

export const DISCOVERY_EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'answer', 'confidence'],
        properties: {
          key: { type: 'string', enum: DISCOVERY_QUESTIONS.map((q) => q.key) },
          answer: { type: 'string', minLength: 1, maxLength: MAX_DISCOVERY_ANSWER_LENGTH },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

export const DISCOVERY_EXTRACT_SYSTEM_PROMPT = [
  'You read a client’s reply in a marketplace conversation and record which of the open discovery questions it answers.',
  'Record only what the client actually said, in their words or a faithful paraphrase; never guess, never fill a gap, never add what a client "probably" means.',
  'A question the reply does not address is left out. Confidence is how sure you are that the text answers that question.',
  'Reply with JSON only, matching the schema.',
].join(' ');

export function buildDiscoveryExtractPrompt(input: {
  readonly questions: readonly DiscoveryQuestion[];
  readonly reply: string;
}): string {
  return [
    'Open questions:',
    ...input.questions.map((q) => `- ${q.key}: ${q.text}`),
    '',
    'The client’s reply:',
    '"""',
    input.reply,
    '"""',
    '',
    'Return {"answers": [{"key", "answer", "confidence"}]} with one entry per question the reply answers.',
  ].join('\n');
}

/** The extractions worth writing: confident, and for a question that is still open. */
export function acceptedDiscoveryAnswers(
  extraction: ModelDiscoveryExtraction,
  answers: DiscoveryAnswers,
  minConfidence: number = DISCOVERY_MIN_CONFIDENCE,
): Record<string, string> {
  const accepted: Record<string, string> = {};
  for (const item of extraction.answers) {
    if (!KEYS.has(item.key) || answers[item.key] !== undefined) continue;
    if (item.confidence < minConfidence) continue;
    const text = item.answer.trim();
    if (text.length === 0) continue;
    accepted[item.key] = text;
  }
  return accepted;
}
