import { parseFeeTable, type FeeRule } from './margin.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * The settings page's rules (ARB-061, docs/01 section G and docs/05 section 1.5: "every
 * form validates on the client and on the server, with the same rules").
 *
 * These functions are the rules. The API runs them on every write and the web page runs
 * the same code before it sends, so the two cannot drift: there is one copy.
 */

/** A percentage with at most three decimals (the columns are numeric(6, 3)). */
const MAX_PERCENT = 999.999;
const MAX_ZAR_MINOR = 1_000_000_000_00; // R1 000 000 000,00
const MAX_RETENTION_DAYS = 3650;

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function percentField(
  errors: FieldError[],
  field: string,
  value: unknown,
  { nullable }: { nullable: boolean },
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    errors.push({ field, message: 'is required' });
    return undefined;
  }
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    errors.push({ field, message: 'must be a number' });
    return undefined;
  }
  if (number < 0) {
    errors.push({ field, message: 'must be zero or more' });
    return undefined;
  }
  if (number > MAX_PERCENT) {
    errors.push({ field, message: `must be ${String(MAX_PERCENT)} or less` });
    return undefined;
  }
  if (decimalsOf(number) > 3) {
    errors.push({ field, message: 'may have at most three decimals' });
    return undefined;
  }
  return number;
}

function wholeField(
  errors: FieldError[],
  field: string,
  value: unknown,
  { min, max, nullable }: { min: number; max: number; nullable: boolean },
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    errors.push({ field, message: 'is required' });
    return undefined;
  }
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    errors.push({ field, message: 'must be a whole number' });
    return undefined;
  }
  if (number < min) {
    errors.push({ field, message: `must be ${String(min)} or more` });
    return undefined;
  }
  if (number > max) {
    errors.push({ field, message: `must be ${String(max)} or less` });
    return undefined;
  }
  return number;
}

export interface MarginRulesInput {
  /** docs/02 D-02. */
  readonly minMarginPct?: number | null;
  /** docs/02 D-02, in cents. */
  readonly minMarginZarMinor?: number | null;
  /** docs/02 D-03. */
  readonly fxBufferPct?: number | null;
  /** docs/01 section G: 15 where VAT applies. */
  readonly vatPct?: number;
  /** docs/02 T-06; null while the legal answer is outstanding. */
  readonly retentionDays?: number | null;
  /** docs/02 T-02, each rule with its source page and date. */
  readonly feeTable?: FeeRule[];
}

/**
 * Reads the margin-rule fields of a settings change. Every field is optional, so a form
 * can save one section at a time; a field that is present must be valid; an empty string
 * or null clears a nullable field. A change with nothing in it is refused.
 */
export function validateMarginRules(input: unknown): ValidationResult<MarginRulesInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const value: {
    -readonly [K in keyof MarginRulesInput]: MarginRulesInput[K];
  } = {};

  const minMarginPct = percentField(errors, 'minMarginPct', body.minMarginPct, {
    nullable: true,
  });
  if (minMarginPct !== undefined) value.minMarginPct = minMarginPct;

  const minMarginZarMinor = wholeField(errors, 'minMarginZarMinor', body.minMarginZarMinor, {
    min: 0,
    max: MAX_ZAR_MINOR,
    nullable: true,
  });
  if (minMarginZarMinor !== undefined) value.minMarginZarMinor = minMarginZarMinor;

  const fxBufferPct = percentField(errors, 'fxBufferPct', body.fxBufferPct, { nullable: true });
  if (fxBufferPct !== undefined) value.fxBufferPct = fxBufferPct;

  const vatPct = percentField(errors, 'vatPct', body.vatPct, { nullable: false });
  if (vatPct !== undefined && vatPct !== null) value.vatPct = vatPct;

  const retentionDays = wholeField(errors, 'retentionDays', body.retentionDays, {
    min: 1,
    max: MAX_RETENTION_DAYS,
    nullable: true,
  });
  if (retentionDays !== undefined) value.retentionDays = retentionDays;

  if (body.feeTable !== undefined) {
    const table = parseFeeTable(body.feeTable);
    if (table.ok) value.feeTable = table.value;
    else
      errors.push(
        ...table.errors.map((error) => ({
          field: error.field
            ? `feeTable${error.field.startsWith('[') ? '' : '.'}${error.field}`
            : 'feeTable',
          message: error.message,
        })),
      );
  }

  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(value).length === 0) {
    return { ok: false, errors: [{ field: '', message: 'no fields to change' }] };
  }
  return { ok: true, value };
}

export interface LiveModeInputs {
  readonly minMarginPct: number | string | null;
  readonly minMarginZarMinor: number | string | null;
  readonly fxBufferPct: number | string | null;
  readonly feeTableLength: number;
  readonly retentionDays: number | null;
}

/**
 * What still stands between this org and live mode. The database refuses the switch
 * while any of these is missing (migrations 0007 and 0010); this is the same list,
 * worded for the person looking at the switch, with the blocker each one answers.
 */
export function liveModeBlockers(settings: LiveModeInputs): string[] {
  const missing: string[] = [];
  if (settings.minMarginPct === null) missing.push('minimum margin % (docs/02 D-02)');
  if (settings.minMarginZarMinor === null) missing.push('minimum margin in rand (docs/02 D-02)');
  if (settings.fxBufferPct === null) missing.push('FX buffer % (docs/02 D-03)');
  if (settings.feeTableLength === 0) missing.push('at least one fee rule (docs/02 T-02)');
  if (settings.retentionDays === null) missing.push('the retention period (docs/02 T-06)');
  return missing;
}

export interface PlanRecordInput {
  readonly planName: string | null;
  readonly monthlyBidAllowance: number | null;
}

export const MAX_PLAN_NAME_LENGTH = 80;
export const MAX_MONTHLY_BID_ALLOWANCE = 10_000;

/** The membership plan and its monthly bid allowance, as recorded on a platform account (D-030, docs/02 T-03). */
export function validatePlanRecord(input: unknown): ValidationResult<PlanRecordInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  let planName: string | null = null;
  if (body.planName !== undefined && body.planName !== null && body.planName !== '') {
    if (typeof body.planName !== 'string')
      errors.push({ field: 'planName', message: 'must be text' });
    else if (body.planName.trim().length === 0)
      errors.push({ field: 'planName', message: 'must not be blank' });
    else if (body.planName.trim().length > MAX_PLAN_NAME_LENGTH)
      errors.push({
        field: 'planName',
        message: `must be ${String(MAX_PLAN_NAME_LENGTH)} characters or fewer`,
      });
    else planName = body.planName.trim();
  }

  const allowance = wholeField(errors, 'monthlyBidAllowance', body.monthlyBidAllowance, {
    min: 0,
    max: MAX_MONTHLY_BID_ALLOWANCE,
    nullable: true,
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { planName, monthlyBidAllowance: allowance ?? null } };
}

export const MAX_PROPOSAL_BODY_LENGTH = 10_000;
export const MAX_REJECTION_REASON_LENGTH = 500;

function requiredText(
  input: unknown,
  field: string,
  max: number,
): ValidationResult<{ text: string }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== 'string') return { ok: false, errors: [{ field, message: 'is required' }] };
  const text = value.trim();
  if (text.length === 0) return { ok: false, errors: [{ field, message: 'must not be blank' }] };
  if (text.length > max) {
    return {
      ok: false,
      errors: [{ field, message: `must be ${String(max)} characters or fewer` }],
    };
  }
  return { ok: true, value: { text } };
}

/** The new words of a bid. The old approval no longer covers them (D-033). */
export function validateProposalEdit(input: unknown): ValidationResult<{ text: string }> {
  return requiredText(input, 'body', MAX_PROPOSAL_BODY_LENGTH);
}

/** Why a bid was rejected: recorded on the proposal and in the event. */
export function validateRejection(input: unknown): ValidationResult<{ text: string }> {
  return requiredText(input, 'reason', MAX_REJECTION_REASON_LENGTH);
}
