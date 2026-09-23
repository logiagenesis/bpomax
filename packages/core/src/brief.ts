import type { DiscoveryAnswers } from './discovery.js';
import { toMinor } from './money.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * The brief (ARB-131, docs/01 section F): "title, one-line outcome, users, must-haves[],
 * later[], references[], assets_provided[], assets_missing[], tech_constraints[],
 * deadline, deadline_fixed, budget {min, max, currency, type}, acceptance_criteria[],
 * sign_off {name, response_time}, risks[], category, delivery_route". Validated here
 * before anything is written; money in minor units (D-024); dates as ISO `YYYY-MM-DD`
 * on the wire, DD/MM/YYYY only on a page. A locked brief needs what the sourcing and
 * pricing path reads (0003's `locked_brief_is_complete`), named here in words.
 */
export const BRIEF_SCHEMA_VERSION = '1';
export const BUDGET_TYPES = ['fixed', 'hourly'] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];
export const DELIVERY_ROUTES = ['in_house', 'ai_build', 'supplier', 'source_new'] as const;
export type DeliveryRoute = (typeof DELIVERY_ROUTES)[number];

export const MAX_BRIEF_TITLE = 200;
export const MAX_BRIEF_TEXT = 1000;
export const MAX_BRIEF_ITEM = 500;
export const MAX_BRIEF_ITEMS = 50;

export interface BriefBudget {
  readonly minMinor: number | null;
  readonly maxMinor: number | null;
  readonly currency: string | null;
  readonly type: BudgetType | null;
}

export interface BriefInput {
  readonly title: string;
  readonly outcome: string;
  readonly users: string | null;
  readonly mustHaves: string[];
  readonly later: string[];
  readonly references: string[];
  readonly assetsProvided: string[];
  readonly assetsMissing: string[];
  readonly techConstraints: string[];
  /** ISO `YYYY-MM-DD`. */
  readonly deadline: string | null;
  readonly deadlineFixed: boolean | null;
  readonly budget: BriefBudget;
  readonly acceptanceCriteria: string[];
  readonly signOff: { readonly name: string | null; readonly responseTime: string | null };
  readonly risks: string[];
  /** A `service_categories.slug`; whether it exists is the API's check. */
  readonly category: string | null;
  readonly deliveryRoute: DeliveryRoute | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9-]+$/;

function text(
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
  required: boolean,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ field, message: 'must not be empty' });
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be text' });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) errors.push({ field, message: 'must not be empty' });
    return null;
  }
  if (trimmed.length > max) {
    errors.push({ field, message: `must be ${String(max)} characters or fewer` });
    return null;
  }
  return trimmed;
}

function list(errors: FieldError[], field: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return [];
  }
  if (value.length > MAX_BRIEF_ITEMS) {
    errors.push({ field, message: `must have ${String(MAX_BRIEF_ITEMS)} items or fewer` });
    return [];
  }
  const items: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push({ field: `${field}[${String(index)}]`, message: 'must be text' });
      return;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > MAX_BRIEF_ITEM) {
      errors.push({
        field: `${field}[${String(index)}]`,
        message: `must be ${String(MAX_BRIEF_ITEM)} characters or fewer`,
      });
      return;
    }
    items.push(trimmed);
  });
  return items;
}

function minor(errors: FieldError[], field: string, value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push({ field, message: 'must be whole minor units, zero or more' });
    return null;
  }
  return value;
}

export function validateBrief(input: unknown): ValidationResult<BriefInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  const title = text(errors, 'title', raw.title, MAX_BRIEF_TITLE, true);
  const outcome = text(errors, 'outcome', raw.outcome, MAX_BRIEF_TEXT, true);
  const users = text(errors, 'users', raw.users, MAX_BRIEF_TEXT, false);

  let deadline: string | null = null;
  if (raw.deadline !== undefined && raw.deadline !== null && raw.deadline !== '') {
    if (
      typeof raw.deadline !== 'string' ||
      !ISO_DATE.test(raw.deadline) ||
      Number.isNaN(Date.parse(`${raw.deadline}T00:00:00Z`))
    ) {
      errors.push({ field: 'deadline', message: 'must be a date as YYYY-MM-DD' });
    } else deadline = raw.deadline;
  }
  let deadlineFixed: boolean | null = null;
  if (raw.deadlineFixed !== undefined && raw.deadlineFixed !== null) {
    if (typeof raw.deadlineFixed !== 'boolean')
      errors.push({ field: 'deadlineFixed', message: 'must be true or false' });
    else deadlineFixed = raw.deadlineFixed;
  }

  const budgetRaw =
    typeof raw.budget === 'object' && raw.budget !== null
      ? (raw.budget as Record<string, unknown>)
      : {};
  const minMinor = minor(errors, 'budget.minMinor', budgetRaw.minMinor);
  const maxMinor = minor(errors, 'budget.maxMinor', budgetRaw.maxMinor);
  let currency: string | null = null;
  if (
    budgetRaw.currency !== undefined &&
    budgetRaw.currency !== null &&
    budgetRaw.currency !== ''
  ) {
    if (
      typeof budgetRaw.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(budgetRaw.currency.toUpperCase())
    ) {
      errors.push({ field: 'budget.currency', message: 'must be a three-letter ISO 4217 code' });
    } else currency = budgetRaw.currency.toUpperCase();
  }
  let type: BudgetType | null = null;
  if (budgetRaw.type !== undefined && budgetRaw.type !== null && budgetRaw.type !== '') {
    if (!BUDGET_TYPES.includes(budgetRaw.type as BudgetType))
      errors.push({ field: 'budget.type', message: 'must be fixed or hourly' });
    else type = budgetRaw.type as BudgetType;
  }
  if ((minMinor !== null || maxMinor !== null) && currency === null) {
    errors.push({ field: 'budget.currency', message: 'is needed with an amount' });
  }
  if (minMinor !== null && maxMinor !== null && minMinor > maxMinor) {
    errors.push({ field: 'budget.maxMinor', message: 'must not be below the minimum' });
  }

  const signOffRaw =
    typeof raw.signOff === 'object' && raw.signOff !== null
      ? (raw.signOff as Record<string, unknown>)
      : {};
  const signOff = {
    name: text(errors, 'signOff.name', signOffRaw.name, MAX_BRIEF_TITLE, false),
    responseTime: text(
      errors,
      'signOff.responseTime',
      signOffRaw.responseTime,
      MAX_BRIEF_TITLE,
      false,
    ),
  };

  let category: string | null = null;
  if (raw.category !== undefined && raw.category !== null && raw.category !== '') {
    if (typeof raw.category !== 'string' || !SLUG.test(raw.category))
      errors.push({ field: 'category', message: 'must be a category slug' });
    else category = raw.category;
  }
  let deliveryRoute: DeliveryRoute | null = null;
  if (raw.deliveryRoute !== undefined && raw.deliveryRoute !== null && raw.deliveryRoute !== '') {
    if (!DELIVERY_ROUTES.includes(raw.deliveryRoute as DeliveryRoute)) {
      errors.push({
        field: 'deliveryRoute',
        message: `must be one of ${DELIVERY_ROUTES.join(', ')}`,
      });
    } else deliveryRoute = raw.deliveryRoute as DeliveryRoute;
  }

  const value: BriefInput = {
    title: title ?? '',
    outcome: outcome ?? '',
    users,
    mustHaves: list(errors, 'mustHaves', raw.mustHaves),
    later: list(errors, 'later', raw.later),
    references: list(errors, 'references', raw.references),
    assetsProvided: list(errors, 'assetsProvided', raw.assetsProvided),
    assetsMissing: list(errors, 'assetsMissing', raw.assetsMissing),
    techConstraints: list(errors, 'techConstraints', raw.techConstraints),
    deadline,
    deadlineFixed,
    budget: { minMinor, maxMinor, currency, type },
    acceptanceCriteria: list(errors, 'acceptanceCriteria', raw.acceptanceCriteria),
    signOff,
    risks: list(errors, 'risks', raw.risks),
    category,
    deliveryRoute,
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/** What a lock still needs, in words; empty means it may lock (mirrors 0003's check). */
export function briefLockBlockers(brief: BriefInput): string[] {
  const missing: string[] = [];
  if (!brief.category) missing.push('a service category');
  if (!brief.deliveryRoute) missing.push('a delivery route');
  if (brief.mustHaves.length === 0) missing.push('at least one must-have');
  if (brief.acceptanceCriteria.length === 0) missing.push('at least one acceptance criterion');
  return missing;
}

/**
 * A first draft from the discovery answers alone, by hand: each answer lands in the
 * field its question is about, as the client's words. Amounts and dates are not read
 * from free text here; the brief-build worker's model does that (D-050).
 */
export function briefFromDiscovery(answers: DiscoveryAnswers, jobTitle: string | null): BriefInput {
  const answer = (key: string): string | null => answers[key]?.answer ?? null;
  const asList = (key: string): string[] => (answer(key) ? [answer(key)!] : []);
  return {
    title: (jobTitle ?? 'Brief').slice(0, MAX_BRIEF_TITLE),
    outcome: (answer('outcome') ?? '').slice(0, MAX_BRIEF_TEXT),
    users: answer('users'),
    mustHaves: asList('day_one'),
    later: [],
    references: asList('references'),
    assetsProvided: asList('assets'),
    assetsMissing: [],
    techConstraints: asList('tech'),
    deadline: null,
    deadlineFixed: null,
    budget: { minMinor: null, maxMinor: null, currency: null, type: null },
    acceptanceCriteria: asList('acceptance'),
    signOff: { name: answer('sign_off'), responseTime: null },
    risks: [],
    category: null,
    deliveryRoute: null,
  };
}

// ----------------------------------------------------------------- the model

/** What the model may fill in from the answers: structure, never facts. Amounts in the currency's major units. */
export interface ModelBrief {
  readonly outcome: string;
  readonly users: string | null;
  readonly must_haves: string[];
  readonly later: string[];
  readonly references: string[];
  readonly assets_provided: string[];
  readonly assets_missing: string[];
  readonly tech_constraints: string[];
  readonly deadline: string | null;
  readonly deadline_fixed: boolean | null;
  readonly budget: {
    readonly min: number | null;
    readonly max: number | null;
    readonly currency: string | null;
    readonly type: BudgetType | null;
  };
  readonly acceptance_criteria: string[];
  readonly sign_off: { readonly name: string | null; readonly response_time: string | null };
  readonly risks: string[];
}

const STRING_LIST = {
  type: 'array',
  maxItems: MAX_BRIEF_ITEMS,
  items: { type: 'string', minLength: 1, maxLength: MAX_BRIEF_ITEM },
};

export const BRIEF_BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'users',
    'must_haves',
    'later',
    'references',
    'assets_provided',
    'assets_missing',
    'tech_constraints',
    'deadline',
    'deadline_fixed',
    'budget',
    'acceptance_criteria',
    'sign_off',
    'risks',
  ],
  properties: {
    outcome: { type: 'string', minLength: 1, maxLength: MAX_BRIEF_TEXT },
    users: { type: ['string', 'null'], maxLength: MAX_BRIEF_TEXT },
    must_haves: STRING_LIST,
    later: STRING_LIST,
    references: STRING_LIST,
    assets_provided: STRING_LIST,
    assets_missing: STRING_LIST,
    tech_constraints: STRING_LIST,
    deadline: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    deadline_fixed: { type: ['boolean', 'null'] },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max', 'currency', 'type'],
      properties: {
        min: { type: ['number', 'null'], minimum: 0 },
        max: { type: ['number', 'null'], minimum: 0 },
        currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
        type: { type: ['string', 'null'], enum: [...BUDGET_TYPES, null] },
      },
    },
    acceptance_criteria: STRING_LIST,
    sign_off: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'response_time'],
      properties: {
        name: { type: ['string', 'null'], maxLength: MAX_BRIEF_TITLE },
        response_time: { type: ['string', 'null'], maxLength: MAX_BRIEF_TITLE },
      },
    },
    risks: STRING_LIST,
  },
} as const;

export const BRIEF_BUILD_SYSTEM_PROMPT = [
  'You turn a client’s discovery answers into a structured brief.',
  'Use only what the answers say. Split a mixed answer into its items; put what must exist on day one under must_haves and what can wait under later.',
  'Leave a field empty or null when the answers do not cover it. Never invent an amount, a date, a name or a requirement.',
  'Amounts are numbers in the currency’s major units with the ISO 4217 code the client used; a date is YYYY-MM-DD; today is given for relative dates.',
  'Risks are only what the answers imply (a fixed deadline with missing assets, a budget below the scope).',
  'Reply with JSON only, matching the schema.',
].join(' ');

export function buildBriefPrompt(input: {
  readonly jobTitle: string | null;
  readonly questions: readonly { readonly key: string; readonly text: string }[];
  readonly answers: DiscoveryAnswers;
  readonly today: string;
}): string {
  return [
    `Today: ${input.today}`,
    `Job: ${input.jobTitle ?? '(no title)'}`,
    '',
    'Discovery answers:',
    ...input.questions.map(
      (q) => `- ${q.key} (${q.text}): ${input.answers[q.key]?.answer ?? '(not answered)'}`,
    ),
    '',
    'Return the brief as JSON matching the schema.',
  ].join('\n');
}

/** The model's structure over the hand draft's facts: amounts to minor units, the rest as validated. */
export function briefFromModel(model: ModelBrief, base: BriefInput): BriefInput {
  const currency = model.budget.currency?.toUpperCase() ?? null;
  const amount = (value: number | null): number | null =>
    value === null || currency === null ? null : toMinor(value, currency);
  return {
    ...base,
    outcome: model.outcome.trim() || base.outcome,
    users: model.users?.trim() || base.users,
    mustHaves: model.must_haves.length > 0 ? model.must_haves : base.mustHaves,
    later: model.later,
    references: model.references.length > 0 ? model.references : base.references,
    assetsProvided: model.assets_provided.length > 0 ? model.assets_provided : base.assetsProvided,
    assetsMissing: model.assets_missing,
    techConstraints:
      model.tech_constraints.length > 0 ? model.tech_constraints : base.techConstraints,
    deadline: model.deadline,
    deadlineFixed: model.deadline_fixed,
    budget: {
      minMinor: amount(model.budget.min),
      maxMinor: amount(model.budget.max),
      currency,
      type: model.budget.type,
    },
    acceptanceCriteria:
      model.acceptance_criteria.length > 0 ? model.acceptance_criteria : base.acceptanceCriteria,
    signOff: {
      name: model.sign_off.name?.trim() || base.signOff.name,
      responseTime: model.sign_off.response_time?.trim() || null,
    },
    risks: model.risks,
  };
}
