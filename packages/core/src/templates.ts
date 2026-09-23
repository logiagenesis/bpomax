import { ratio, type Ratio } from './analytics.js';
import type { FieldError, ValidationResult } from './scanners.js';
import { MAX_PROPOSAL_BODY_LENGTH } from './settings.js';

/**
 * Bid templates and their A/B variants (ARB-340, docs/01 section I: "templates (variants,
 * reply rates)"). The drafter writes from a template's variants in turn (D-064); the page
 * shows each variant's sends and replies, counted from the stored rows by the
 * `template_variant_stats` view, and the owner switches off the variant that loses.
 *
 * Reply rate = replies ÷ sends. A send is a bid that went (`submitted`) written from the
 * variant; a reply is one of those whose job's conversation had a client message at or
 * after the bid went, the same rule as analytics (D-061).
 */
export const MAX_TEMPLATE_NAME = 120;
export const MAX_TEMPLATE_DESCRIPTION = 500;
export const MAX_VARIANT_LABEL = 40;
/** A variant is the model's starting point for a bid, so it is held to a bid's length. */
export const MAX_VARIANT_BODY = MAX_PROPOSAL_BODY_LENGTH;

export interface TemplateChange {
  readonly name?: string;
  /** Null: a general template, used for a job with no category or none of its own. */
  readonly categorySlug?: string | null;
  readonly description?: string | null;
  readonly active?: boolean;
}

export interface VariantChange {
  readonly label?: string;
  readonly body?: string;
  readonly active?: boolean;
}

type Body = Record<string, unknown>;

function asObject(input: unknown): Body | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Body)
    : null;
}

function text(
  body: Body,
  field: string,
  max: number,
  errors: FieldError[],
  { required, nullable }: { required: boolean; nullable: boolean },
): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    if (required) errors.push({ field, message: 'is required' });
    return undefined;
  }
  if (value === null || (typeof value === 'string' && value.trim() === '' && nullable)) {
    if (!nullable) errors.push({ field, message: 'is required' });
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be text' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push({ field, message: 'must not be blank' });
    return undefined;
  }
  if (trimmed.length > max) {
    errors.push({ field, message: `must be ${String(max)} characters or fewer` });
    return undefined;
  }
  return trimmed;
}

function flag(body: Body, field: string, errors: FieldError[]): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    errors.push({ field, message: 'must be true or false' });
    return undefined;
  }
  return value;
}

/**
 * A new template (`partial` false: a name is required) or a change to one (`partial`
 * true: at least one field). Whether the category exists is the API's to check.
 */
export function validateTemplateChange(
  input: unknown,
  { partial }: { partial: boolean },
): ValidationResult<TemplateChange> {
  const body = asObject(input);
  if (!body) return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  const errors: FieldError[] = [];
  const name = text(body, 'name', MAX_TEMPLATE_NAME, errors, {
    required: !partial,
    nullable: false,
  });
  const categorySlug = text(body, 'categorySlug', 64, errors, { required: false, nullable: true });
  const description = text(body, 'description', MAX_TEMPLATE_DESCRIPTION, errors, {
    required: false,
    nullable: true,
  });
  const active = flag(body, 'active', errors);
  if (errors.length > 0) return { ok: false, errors };
  const value: TemplateChange = {
    ...(name === undefined || name === null ? {} : { name }),
    ...(categorySlug === undefined ? {} : { categorySlug }),
    ...(description === undefined ? {} : { description }),
    ...(active === undefined ? {} : { active }),
  };
  if (partial && Object.keys(value).length === 0)
    return {
      ok: false,
      errors: [{ field: 'name', message: 'send a name, a category, a description or active' }],
    };
  return { ok: true, value };
}

/** A new variant (`partial` false: a label and words are required) or a change to one. */
export function validateVariantChange(
  input: unknown,
  { partial }: { partial: boolean },
): ValidationResult<VariantChange> {
  const body = asObject(input);
  if (!body) return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  const errors: FieldError[] = [];
  const label = text(body, 'label', MAX_VARIANT_LABEL, errors, {
    required: !partial,
    nullable: false,
  });
  const words = text(body, 'body', MAX_VARIANT_BODY, errors, {
    required: !partial,
    nullable: false,
  });
  const active = flag(body, 'active', errors);
  if (errors.length > 0) return { ok: false, errors };
  const value: VariantChange = {
    ...(label === undefined || label === null ? {} : { label }),
    ...(words === undefined || words === null ? {} : { body: words }),
    ...(active === undefined ? {} : { active }),
  };
  if (partial && Object.keys(value).length === 0)
    return {
      ok: false,
      errors: [{ field: 'label', message: 'send a label, the words or active' }],
    };
  return { ok: true, value };
}

/**
 * Why a variant's words cannot change, or null when they can: once a bid written from it
 * has gone, its rate measures those words, so new words are a new variant.
 */
export function variantWordsLocked(sends: number): string | null {
  if (sends === 0) return null;
  return `This variant has been sent ${String(sends)} time${sends === 1 ? '' : 's'}, and its reply rate measures these words. Add a new variant with the new words, and switch this one off if it should stop.`;
}

export interface VariantFigures {
  readonly sends: number;
  readonly replies: number;
  readonly replyRate: Ratio;
}

/** A variant's figures as the view counted them. */
export function variantFigures(sends: number, replies: number): VariantFigures {
  return { sends, replies, replyRate: ratio(replies, sends) };
}

/** A template's figures: its variants' sends and replies added up, and the rate of those. */
export function templateFigures(variants: readonly VariantFigures[]): VariantFigures {
  let sends = 0;
  let replies = 0;
  for (const v of variants) {
    sends += v.sends;
    replies += v.replies;
  }
  return variantFigures(sends, replies);
}
