// @ts-check
/**
 * Display formats (ARB-060, docs/01 sections D and I, docs/05 section 2).
 *
 * Dates are DD/MM/YYYY and times 24-hour, both in SAST. Money is stored as integer minor
 * units and formatted here without ever becoming a float. The chosen money format is
 * `R1 234,56` — DECISIONS.md D-024 says why, and says it is used everywhere.
 */

/**
 * South Africa Standard Time is UTC+02:00 all year: the country has observed no daylight
 * saving since 1944. A fixed offset keeps the output identical on every machine,
 * whatever time zone data its browser ships with.
 */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {Date | string | number} value
 * @returns {Date}
 */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a date: ${String(value)}`);
  return date;
}

/**
 * @param {Date | string | number} value
 * @returns {Date} a Date whose UTC fields read as SAST wall-clock time
 */
function inSast(value) {
  return new Date(toDate(value).getTime() + SAST_OFFSET_MS);
}

/**
 * `22/09/2026`
 * @param {Date | string | number} value
 */
export function formatDate(value) {
  const d = inSast(value);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * `17:05`
 * @param {Date | string | number} value
 */
export function formatTime(value) {
  const d = inSast(value);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * `22/09/2026 17:05`
 * @param {Date | string | number} value
 */
export function formatDateTime(value) {
  return `${formatDate(value)} ${formatTime(value)}`;
}

/** Digits after the decimal point, per ISO 4217. Two unless listed. */
const MINOR_DIGITS = /** @type {Record<string, number>} */ ({
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
});

/** Prefixes. The rand has its own; every other currency is shown by its ISO code. */
const PREFIX = /** @type {Record<string, string>} */ ({ ZAR: 'R' });

/** A no-break space, so an amount never wraps across two lines. */
const GROUP = ' ';

/**
 * Formats integer minor units: `formatMoney(123456, 'ZAR')` is `R1 234,56`, and
 * `formatMoney(123456, 'USD')` is `USD 1 234,56`.
 *
 * @param {number | bigint} minor
 * @param {string} currency ISO 4217 code
 */
export function formatMoney(minor, currency) {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new RangeError(`money must be whole minor units, got ${minor}`);
  }
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new RangeError(`not a currency code: ${currency}`);

  const digits = MINOR_DIGITS[code] ?? 2;
  const negative = minor < 0;
  const abs = (negative ? -BigInt(minor) : BigInt(minor)).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const fraction = abs.slice(abs.length - digits);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  const number = digits > 0 ? `${grouped},${fraction}` : grouped;
  const prefix = PREFIX[code] ?? `${code} `;
  return `${negative ? '-' : ''}${prefix}${number}`;
}

/**
 * `12,5%` — a ratio from 0 to 1 as a percentage, with the same decimal comma as money.
 * @param {number} ratio
 * @param {number} [decimals]
 */
export function formatPercent(ratio, decimals = 1) {
  return `${(ratio * 100).toFixed(decimals).replace('.', ',')}%`;
}

/**
 * Reads a date typed as DD/MM/YYYY and returns the instant that SAST day starts, as an
 * ISO string in UTC — or null when the text is not a real date. `endOfDay` returns the
 * start of the next day instead, for an exclusive upper bound that includes the whole day.
 *
 * Native date pickers are not used for this: Chromium lays them out in the browser's
 * own locale, which shows MM/DD/YYYY to anyone with a US-English browser.
 *
 * @param {string} text
 * @param {{ endOfDay?: boolean }} [options]
 * @returns {string | null}
 */
export function parseDateSast(text, options = {}) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utcMidnight = Date.UTC(year, month - 1, day);
  const check = new Date(utcMidnight);
  // Date.UTC rolls 31/02 over into March; a date that does not round-trip did not exist.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  return new Date(utcMidnight - SAST_OFFSET_MS + (options.endOfDay ? dayMs : 0)).toISOString();
}
