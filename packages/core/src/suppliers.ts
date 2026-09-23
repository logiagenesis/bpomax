import { SUPPLIER_CHANNELS, type SupplierChannel } from './estimating.js';
import { minorDigits, parseAmountText } from './money.js';

/**
 * The supplier database's CSV (ARB-200, docs/01 section D: `suppliers` and
 * `supplier_rate_cards`; docs/02 D-09: the owner supplies the list as a CSV). One line
 * per supplier and rate card: a supplier with three rate cards is three lines with the
 * same name, and a supplier with none is one line with the rate-card columns empty.
 * Every line is checked and every problem is reported with its line number before a
 * single row is written (the ticket's acceptance). Amounts are parsed as text into
 * minor units; nothing here touches a float.
 */

export const SUPPLIER_CSV_COLUMNS = [
  'name',
  'country_code',
  'time_zone',
  'channel',
  'languages',
  'quality_score',
  'on_time_rate',
  'pays_after_delivery',
  'external_profile_url',
  'notes',
  'active',
  'category_slug',
  'currency',
  'fixed_price',
  'hourly_rate',
  'turnaround_days',
] as const;
export type SupplierCsvColumn = (typeof SUPPLIER_CSV_COLUMNS)[number];

export const MAX_SUPPLIER_NAME = 200;
export const MAX_SUPPLIER_NOTES = 2000;
export const MAX_SUPPLIER_LANGUAGES = 10;
export const MAX_SUPPLIER_CSV_LINES = 5000;
/** The template's sample line, which an import refuses so it is never stored as a supplier. */
export const SUPPLIER_SAMPLE_NAME = 'Example Supplier (sample)';

export interface SupplierRateCardInput {
  readonly categorySlug: string;
  readonly currency: string;
  /** Whole minor units as text (no float), or null. At least one of the two is set. */
  readonly fixedPriceMinor: string | null;
  readonly hourlyRateMinor: string | null;
  readonly turnaroundDays: number | null;
  /** The CSV line this card came from, for a message that names it. */
  readonly line: number;
}

export interface SupplierInput {
  readonly name: string;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly channel: SupplierChannel;
  readonly languages: string[];
  /** `0.00` to `100.00` as text, or null. */
  readonly qualityScore: string | null;
  /** `0.000` to `1.000` as text, or null. */
  readonly onTimeRate: string | null;
  readonly paysAfterDelivery: boolean;
  readonly externalProfileUrl: string | null;
  readonly notes: string | null;
  readonly active: boolean;
  readonly rateCards: SupplierRateCardInput[];
  /** The first CSV line that named this supplier. */
  readonly line: number;
}

export interface CsvLineError {
  /** 1-based; line 1 is the heading. */
  readonly line: number;
  readonly field: string;
  readonly message: string;
}

export type SupplierCsvResult =
  | { readonly ok: true; readonly value: SupplierInput[]; readonly lines: number }
  | { readonly ok: false; readonly errors: CsvLineError[] };

// ------------------------------------------------------------------ CSV itself
/**
 * RFC 4180: fields separated by commas, a field with a comma, quote or line break is
 * quoted, a quote inside is doubled. CRLF and LF both end a line. A quoted field may
 * span lines, so the parser reports the line each record started on.
 */
export function parseCsv(text: string):
  | { readonly ok: true; readonly records: { line: number; fields: string[] }[] }
  | {
      readonly ok: false;
      readonly error: CsvLineError;
    } {
  const records: { line: number; fields: string[] }[] = [];
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== '') records.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };
  while (i < source.length) {
    const c = source[i] as string;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        if (i < source.length && source[i] !== ',' && source[i] !== '\n' && source[i] !== '\r') {
          return {
            ok: false,
            error: {
              line,
              field: '',
              message: 'a closing quote must be followed by a comma or the end of the line',
            },
          };
        }
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field !== '') {
        return {
          ok: false,
          error: { line, field: '', message: 'a quote may only open a field' },
        };
      }
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      i += 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) {
    return {
      ok: false,
      error: { line: recordLine, field: '', message: 'a quoted field is never closed' },
    };
  }
  if (field !== '' || fields.length > 0) endRecord();
  return { ok: true, records };
}

/** RFC 4180 quoting plus protection against formula injection (as the audit log's export). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// ------------------------------------------------------------------ the template
/** The heading line and one sample line, which the import refuses by name. */
export function supplierCsvTemplate(): string {
  const sample: Record<SupplierCsvColumn, string> = {
    name: SUPPLIER_SAMPLE_NAME,
    country_code: 'ZA',
    time_zone: 'Africa/Johannesburg',
    channel: 'direct',
    languages: 'en;zu',
    quality_score: '85',
    on_time_rate: '0.95',
    pays_after_delivery: 'yes',
    external_profile_url: 'https://example.com/profile',
    notes: 'Replace this line with your suppliers; one line per supplier and rate card.',
    active: 'yes',
    category_slug: 'wordpress',
    currency: 'ZAR',
    fixed_price: '1500.00',
    hourly_rate: '',
    turnaround_days: '5',
  };
  return `${SUPPLIER_CSV_COLUMNS.join(',')}\r\n${SUPPLIER_CSV_COLUMNS.map((c) => csvCell(sample[c])).join(',')}\r\n`;
}

// ------------------------------------------------------------------ validation
const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);
const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SLUG = /^[a-z0-9-]+$/;

function yesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return undefined as unknown as null;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `85` → `85.00`, `0.95` → `0.950`; null when not a number in range. Text in, text out. */
function decimalInRange(value: string, max: number, places: number): string | null | undefined {
  const v = value.trim().replace(',', '.');
  if (v === '') return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!match) return undefined;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(places, '0');
  if (fraction.length > places) return undefined;
  const asMinor = BigInt(`${whole}${fraction}`);
  if (asMinor > BigInt(max) * BigInt(10 ** places)) return undefined;
  return `${whole}.${fraction}`;
}

/**
 * Every line checked; every problem reported with its line number; nothing returned
 * for import unless every line is right. Lines with the same supplier name are one
 * supplier with several rate cards, and their supplier fields must agree.
 */
export function validateSupplierCsv(
  text: string,
  options: { readonly categories: ReadonlySet<string> },
): SupplierCsvResult {
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const errors: CsvLineError[] = [];
  const [heading, ...records] = parsed.records;
  if (!heading) {
    return { ok: false, errors: [{ line: 1, field: '', message: 'the file is empty' }] };
  }
  const found = heading.fields.map((h) => h.trim().toLowerCase());
  const expected = [...SUPPLIER_CSV_COLUMNS];
  if (found.join(',') !== expected.join(',')) {
    const missing = expected.filter((c) => !found.includes(c));
    const extra = found.filter((c) => !expected.includes(c as SupplierCsvColumn));
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      extra.length > 0 ? `unexpected ${extra.join(', ')}` : '',
      missing.length === 0 && extra.length === 0 ? 'the columns are out of order' : '',
    ].filter(Boolean);
    return {
      ok: false,
      errors: [
        {
          line: 1,
          field: '',
          message: `the heading must be exactly: ${expected.join(',')} (${parts.join('; ')})`,
        },
      ],
    };
  }
  if (records.length === 0) {
    return {
      ok: false,
      errors: [{ line: 1, field: '', message: 'the file has a heading and no supplier lines' }],
    };
  }
  if (records.length > MAX_SUPPLIER_CSV_LINES) {
    return {
      ok: false,
      errors: [
        {
          line: MAX_SUPPLIER_CSV_LINES + 2,
          field: '',
          message: `a file may hold at most ${String(MAX_SUPPLIER_CSV_LINES)} supplier lines`,
        },
      ],
    };
  }

  const suppliers = new Map<string, SupplierInput & { rateCards: SupplierRateCardInput[] }>();
  const cardKeys = new Map<string, number>();

  for (const record of records) {
    const line = record.line;
    const problem = (field: string, message: string) => errors.push({ line, field, message });
    if (record.fields.length !== expected.length) {
      problem('', `has ${String(record.fields.length)} fields, not ${String(expected.length)}`);
      continue;
    }
    const cell = Object.fromEntries(
      expected.map((c, i) => [c, (record.fields[i] ?? '').trim()]),
    ) as Record<SupplierCsvColumn, string>;

    const name = cell.name;
    if (name === '') problem('name', 'must not be empty');
    else if (name.length > MAX_SUPPLIER_NAME)
      problem('name', `must be ${String(MAX_SUPPLIER_NAME)} characters or fewer`);
    else if (name.toLowerCase() === SUPPLIER_SAMPLE_NAME.toLowerCase())
      problem('name', 'is the sample line from the template; replace it with a real supplier');

    const countryCode = cell.country_code === '' ? null : cell.country_code.toUpperCase();
    if (countryCode !== null && !COUNTRY.test(countryCode))
      problem('country_code', 'must be a two-letter country code such as ZA');

    const timeZone = cell.time_zone === '' ? null : cell.time_zone;
    if (timeZone !== null && !isTimeZone(timeZone))
      problem('time_zone', 'must be a time zone name such as Africa/Johannesburg');

    const channel = cell.channel.toLowerCase();
    if (!SUPPLIER_CHANNELS.includes(channel as SupplierChannel))
      problem('channel', `must be one of ${SUPPLIER_CHANNELS.join(', ')}`);

    const languages = cell.languages
      .split(/[;|]/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (languages.length > MAX_SUPPLIER_LANGUAGES)
      problem('languages', `may list at most ${String(MAX_SUPPLIER_LANGUAGES)}`);

    const qualityScore = decimalInRange(cell.quality_score, 100, 2);
    if (qualityScore === undefined) problem('quality_score', 'must be a number from 0 to 100');
    const onTimeRate = decimalInRange(cell.on_time_rate, 1, 3);
    if (onTimeRate === undefined) problem('on_time_rate', 'must be a number from 0 to 1');

    const pays = yesNo(cell.pays_after_delivery);
    if (pays === undefined) problem('pays_after_delivery', 'must be yes or no');
    const active = yesNo(cell.active);
    if (active === undefined) problem('active', 'must be yes or no');

    const externalProfileUrl = cell.external_profile_url === '' ? null : cell.external_profile_url;
    if (externalProfileUrl !== null) {
      let fine = false;
      try {
        const url = new URL(externalProfileUrl);
        fine = url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        fine = false;
      }
      if (!fine) problem('external_profile_url', 'must be a web address starting with https://');
    }
    const notes = cell.notes === '' ? null : cell.notes;
    if (notes !== null && notes.length > MAX_SUPPLIER_NOTES)
      problem('notes', `must be ${String(MAX_SUPPLIER_NOTES)} characters or fewer`);

    // The rate card, when the line carries one.
    const categorySlug = cell.category_slug.toLowerCase();
    const currency = cell.currency.toUpperCase();
    const hasCardField =
      categorySlug !== '' ||
      currency !== '' ||
      cell.fixed_price !== '' ||
      cell.hourly_rate !== '' ||
      cell.turnaround_days !== '';
    let card: SupplierRateCardInput | null = null;
    if (hasCardField) {
      if (categorySlug === '') problem('category_slug', 'is needed when the line carries a rate');
      else if (!SLUG.test(categorySlug) || !options.categories.has(categorySlug))
        problem('category_slug', 'is not a service category');
      if (currency === '') problem('currency', 'is needed when the line carries a rate');
      else if (!CURRENCY.test(currency))
        problem('currency', 'must be a three-letter currency code such as ZAR');
      const fixed =
        cell.fixed_price === '' ? null : parseAmountText(cell.fixed_price, currency || 'ZAR');
      if (cell.fixed_price !== '' && fixed === null)
        problem('fixed_price', 'must be an amount such as 1500.00');
      const hourly =
        cell.hourly_rate === '' ? null : parseAmountText(cell.hourly_rate, currency || 'ZAR');
      if (cell.hourly_rate !== '' && hourly === null)
        problem('hourly_rate', 'must be an amount such as 350.00');
      if (cell.fixed_price === '' && cell.hourly_rate === '')
        problem('fixed_price', 'a rate card needs a fixed price or an hourly rate');
      let turnaround: number | null = null;
      if (cell.turnaround_days !== '') {
        if (!/^\d{1,4}$/.test(cell.turnaround_days))
          problem('turnaround_days', 'must be a whole number of days');
        else turnaround = Number(cell.turnaround_days);
      }
      card = {
        categorySlug,
        currency,
        fixedPriceMinor: fixed,
        hourlyRateMinor: hourly,
        turnaroundDays: turnaround,
        line,
      };
      const key = `${name.toLowerCase()}|${categorySlug}|${currency}`;
      const earlier = cardKeys.get(key);
      if (earlier !== undefined && categorySlug !== '' && currency !== '') {
        problem(
          'category_slug',
          `repeats the ${categorySlug} ${currency} rate card from line ${String(earlier)}`,
        );
      } else cardKeys.set(key, line);
    }

    const supplier: SupplierInput = {
      name,
      countryCode,
      timeZone,
      channel: channel as SupplierChannel,
      languages,
      qualityScore: qualityScore ?? null,
      onTimeRate: onTimeRate ?? null,
      paysAfterDelivery: pays ?? false,
      externalProfileUrl,
      notes,
      active: active ?? true,
      rateCards: [],
      line,
    };
    const existing = suppliers.get(name.toLowerCase());
    if (existing) {
      const differs = (
        [
          'countryCode',
          'timeZone',
          'channel',
          'qualityScore',
          'onTimeRate',
          'paysAfterDelivery',
          'externalProfileUrl',
          'notes',
          'active',
        ] as const
      ).filter((k) => existing[k] !== supplier[k]);
      if (existing.languages.join(';') !== supplier.languages.join(';')) differs.push('notes');
      if (differs.length > 0) {
        problem(
          'name',
          `describes ${name} differently from line ${String(existing.line)}; a supplier's own fields must match on every line`,
        );
      }
      if (card) existing.rateCards.push(card);
    } else {
      suppliers.set(name.toLowerCase(), {
        ...supplier,
        rateCards: card ? [card] : [],
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: [...suppliers.values()], lines: records.length };
}

// ------------------------------------------------------------------ export
export interface SupplierExportRow {
  readonly name: string;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly channel: string;
  readonly languages: readonly string[];
  readonly qualityScore: string | null;
  readonly onTimeRate: string | null;
  readonly paysAfterDelivery: boolean;
  readonly externalProfileUrl: string | null;
  readonly notes: string | null;
  readonly active: boolean;
  readonly rateCards: readonly {
    readonly categorySlug: string;
    readonly currency: string;
    readonly fixedPriceMinor: string | null;
    readonly hourlyRateMinor: string | null;
    readonly turnaroundDays: number | null;
  }[];
}

/** Whole minor units as `1500.00`: a dot, no grouping, so a spreadsheet reads it as a number and the import reads it back. */
export function minorToCsvAmount(minor: string | null, currency: string): string {
  if (minor === null) return '';
  const digits = minorDigits(currency);
  const abs = minor.replace(/^-/, '').padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const fraction = abs.slice(abs.length - digits);
  return `${minor.startsWith('-') ? '-' : ''}${whole}${digits > 0 ? `.${fraction}` : ''}`;
}

/** The same columns as the template, one line per supplier and rate card, so an export imports again unchanged. */
export function suppliersToCsv(rows: readonly SupplierExportRow[]): string {
  const lines = [SUPPLIER_CSV_COLUMNS.join(',')];
  for (const s of rows) {
    const base: Record<SupplierCsvColumn, string> = {
      name: s.name,
      country_code: s.countryCode ?? '',
      time_zone: s.timeZone ?? '',
      channel: s.channel,
      languages: s.languages.join(';'),
      quality_score: s.qualityScore ?? '',
      on_time_rate: s.onTimeRate ?? '',
      pays_after_delivery: s.paysAfterDelivery ? 'yes' : 'no',
      external_profile_url: s.externalProfileUrl ?? '',
      notes: s.notes ?? '',
      active: s.active ? 'yes' : 'no',
      category_slug: '',
      currency: '',
      fixed_price: '',
      hourly_rate: '',
      turnaround_days: '',
    };
    const cards = s.rateCards.length > 0 ? s.rateCards : [null];
    for (const card of cards) {
      const row = card
        ? {
            ...base,
            category_slug: card.categorySlug,
            currency: card.currency,
            fixed_price: minorToCsvAmount(card.fixedPriceMinor, card.currency),
            hourly_rate: minorToCsvAmount(card.hourlyRateMinor, card.currency),
            turnaround_days: card.turnaroundDays === null ? '' : String(card.turnaroundDays),
          }
        : base;
      lines.push(SUPPLIER_CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
