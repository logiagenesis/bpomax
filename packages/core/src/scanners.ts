/**
 * Scanner validation (ARB-021, docs/01 sections D and H).
 *
 * A scanner is a saved search that runs on a timer and can, if the operator turns it on,
 * bid without anyone looking first. That is the most dangerous object in the system, so
 * every field is checked here and the dangerous combination is refused by the database
 * as well (migration 0002, `auto_send_requires_guardrails`).
 */
export const PLATFORMS = ['freelancer', 'upwork', 'fiverr'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Freelancer.com's own polling guidance is the floor; below this we are hammering. */
export const MIN_POLL_INTERVAL_SECONDS = 60;
export const MAX_POLL_INTERVAL_SECONDS = 86_400;
export const MAX_DAILY_CAP = 100;

export interface ScannerFilters {
  readonly keywords?: string[];
  readonly categorySlugs?: string[];
  readonly budgetMinMinor?: number;
  readonly currency?: string;
  readonly clientCountriesInclude?: string[];
  readonly clientCountriesExclude?: string[];
  readonly hourly?: boolean;
}

export interface ScannerInput {
  readonly name: string;
  readonly platform?: Platform;
  readonly filters?: ScannerFilters;
  readonly pollIntervalSeconds?: number;
  readonly active?: boolean;
  readonly autoSend?: boolean;
  readonly minScore?: number | null;
  readonly dailyCap?: number;
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldError[] };

export interface ValidScanner {
  readonly name: string;
  readonly platform: Platform;
  readonly filters: ScannerFilters;
  readonly pollIntervalSeconds: number;
  readonly active: boolean;
  readonly autoSend: boolean;
  readonly minScore: number | null;
  readonly dailyCap: number;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function validateStringList(
  value: unknown,
  field: string,
  errors: FieldError[],
  each?: (item: string) => string | null,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push({ field: `${field}[${String(index)}]`, message: 'must be a non-empty string' });
      return;
    }
    const problem = each?.(item);
    if (problem) {
      errors.push({ field: `${field}[${String(index)}]`, message: problem });
      return;
    }
    out.push(item.trim());
  });
  return out;
}

function validateFilters(value: unknown, errors: FieldError[]): ScannerFilters {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ field: 'filters', message: 'must be an object' });
    return {};
  }
  const raw = value as Record<string, unknown>;
  const known = new Set([
    'keywords',
    'categorySlugs',
    'budgetMinMinor',
    'currency',
    'clientCountriesInclude',
    'clientCountriesExclude',
    'hourly',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors.push({ field: `filters.${key}`, message: 'is not a filter this scanner understands' });
    }
  }

  const filters: {
    keywords?: string[];
    categorySlugs?: string[];
    budgetMinMinor?: number;
    currency?: string;
    clientCountriesInclude?: string[];
    clientCountriesExclude?: string[];
    hourly?: boolean;
  } = {};

  const keywords = validateStringList(raw.keywords, 'filters.keywords', errors);
  if (keywords) filters.keywords = keywords;

  const categories = validateStringList(
    raw.categorySlugs,
    'filters.categorySlugs',
    errors,
    (slug) => (/^[a-z0-9-]+$/.test(slug) ? null : 'must be a lower-case slug'),
  );
  if (categories) filters.categorySlugs = categories;

  const include = validateStringList(
    raw.clientCountriesInclude,
    'filters.clientCountriesInclude',
    errors,
    (code) => (COUNTRY_CODE.test(code) ? null : 'must be a two-letter country code'),
  );
  if (include) filters.clientCountriesInclude = include;

  const exclude = validateStringList(
    raw.clientCountriesExclude,
    'filters.clientCountriesExclude',
    errors,
    (code) => (COUNTRY_CODE.test(code) ? null : 'must be a two-letter country code'),
  );
  if (exclude) filters.clientCountriesExclude = exclude;

  if (include && exclude) {
    const both = include.filter((code) => exclude.includes(code));
    if (both.length > 0) {
      errors.push({
        field: 'filters.clientCountriesExclude',
        message: `${both.join(', ')} cannot be both included and excluded`,
      });
    }
  }

  if (raw.budgetMinMinor !== undefined) {
    if (!isWholeNumber(raw.budgetMinMinor) || raw.budgetMinMinor < 0) {
      errors.push({
        field: 'filters.budgetMinMinor',
        message: 'must be a whole number of minor units, zero or more',
      });
    } else {
      filters.budgetMinMinor = raw.budgetMinMinor;
    }
  }

  if (raw.currency !== undefined) {
    if (typeof raw.currency !== 'string' || !CURRENCY_CODE.test(raw.currency)) {
      errors.push({ field: 'filters.currency', message: 'must be a three-letter ISO 4217 code' });
    } else {
      filters.currency = raw.currency;
    }
  }

  if (raw.budgetMinMinor !== undefined && raw.currency === undefined) {
    errors.push({
      field: 'filters.currency',
      message: 'is required when a budget floor is set, since a floor without one means nothing',
    });
  }

  if (raw.hourly !== undefined) {
    if (typeof raw.hourly !== 'boolean') {
      errors.push({ field: 'filters.hourly', message: 'must be true or false' });
    } else {
      filters.hourly = raw.hourly;
    }
  }

  return filters;
}

/**
 * Validates a whole scanner. `partial` is for edits: fields that are absent are left
 * alone rather than reset to a default.
 */
export function validateScanner(
  input: unknown,
  options: { partial?: boolean } = {},
): ValidationResult<Partial<ValidScanner>> {
  const errors: FieldError[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const raw = input as Record<string, unknown>;

  const known = new Set([
    'name',
    'platform',
    'filters',
    'pollIntervalSeconds',
    'active',
    'autoSend',
    'minScore',
    'dailyCap',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push({ field: key, message: 'is not a field on a scanner' });
  }

  const value: Record<string, unknown> = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      errors.push({ field: 'name', message: 'must not be empty' });
    } else if (raw.name.trim().length > 80) {
      errors.push({ field: 'name', message: 'must be 80 characters or fewer' });
    } else {
      value.name = raw.name.trim();
    }
  } else if (!options.partial) {
    errors.push({ field: 'name', message: 'is required' });
  }

  if (raw.platform !== undefined) {
    if (!PLATFORMS.includes(raw.platform as Platform)) {
      errors.push({ field: 'platform', message: `must be one of ${PLATFORMS.join(', ')}` });
    } else {
      value.platform = raw.platform;
    }
  } else if (!options.partial) {
    value.platform = 'freelancer';
  }

  if (raw.filters !== undefined || !options.partial) {
    value.filters = validateFilters(raw.filters, errors);
  }

  if (raw.pollIntervalSeconds !== undefined) {
    if (
      !isWholeNumber(raw.pollIntervalSeconds) ||
      raw.pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS ||
      raw.pollIntervalSeconds > MAX_POLL_INTERVAL_SECONDS
    ) {
      errors.push({
        field: 'pollIntervalSeconds',
        message: `must be a whole number between ${String(MIN_POLL_INTERVAL_SECONDS)} and ${String(MAX_POLL_INTERVAL_SECONDS)}`,
      });
    } else {
      value.pollIntervalSeconds = raw.pollIntervalSeconds;
    }
  } else if (!options.partial) {
    value.pollIntervalSeconds = 120;
  }

  for (const flag of ['active', 'autoSend'] as const) {
    if (raw[flag] !== undefined) {
      if (typeof raw[flag] !== 'boolean') {
        errors.push({ field: flag, message: 'must be true or false' });
      } else {
        value[flag] = raw[flag];
      }
    } else if (!options.partial) {
      // Auto-send is off unless someone deliberately turns it on (01 section H).
      value[flag] = flag === 'active';
    }
  }

  if (raw.minScore !== undefined) {
    if (raw.minScore === null) {
      value.minScore = null;
    } else if (!isWholeNumber(raw.minScore) || raw.minScore < 0 || raw.minScore > 100) {
      errors.push({ field: 'minScore', message: 'must be a whole number between 0 and 100' });
    } else {
      value.minScore = raw.minScore;
    }
  } else if (!options.partial) {
    value.minScore = null;
  }

  if (raw.dailyCap !== undefined) {
    if (!isWholeNumber(raw.dailyCap) || raw.dailyCap < 0 || raw.dailyCap > MAX_DAILY_CAP) {
      errors.push({
        field: 'dailyCap',
        message: `must be a whole number between 0 and ${String(MAX_DAILY_CAP)}`,
      });
    } else {
      value.dailyCap = raw.dailyCap;
    }
  } else if (!options.partial) {
    value.dailyCap = 0;
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as Partial<ValidScanner> };
}

/**
 * The guardrail check, against the scanner as it will be *after* an edit. Turning
 * auto-send on is not a field change like any other: it is the moment the system
 * becomes able to bid with nobody watching, so it needs a cap and a score floor.
 */
export function checkAutoSendGuardrails(scanner: {
  autoSend?: boolean;
  dailyCap?: number;
  minScore?: number | null;
}): FieldError[] {
  if (!scanner.autoSend) return [];
  const errors: FieldError[] = [];
  if (!scanner.dailyCap || scanner.dailyCap < 1) {
    errors.push({
      field: 'dailyCap',
      message: 'must be at least 1 before auto-send can be turned on',
    });
  }
  if (scanner.minScore === null || scanner.minScore === undefined) {
    errors.push({
      field: 'minScore',
      message: 'must be set before auto-send can be turned on',
    });
  }
  return errors;
}
