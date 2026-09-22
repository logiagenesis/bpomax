/**
 * Money for people to read (D-024): `R1 234,56`, and `USD 1 234,56` for any other
 * currency. The web app's `apps/web/src/lib/format.js` is the original; this is the same
 * rule for the places that are not a browser — the Telegram cards, first of all — and
 * `money.test.ts` holds the two to the same outputs.
 *
 * Nothing here is a float: the minor units are split as digits.
 */

/** Digits after the decimal point, per ISO 4217. Two unless listed. */
const MINOR_DIGITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

/** Prefixes. The rand has its own; every other currency is shown by its ISO code. */
const PREFIX: Record<string, string> = { ZAR: 'R' };

/** A no-break space, so an amount never wraps across two lines. */
const GROUP = ' ';

export function formatMoney(minor: number | bigint, currency: string): string {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new RangeError(`money must be whole minor units, got ${String(minor)}`);
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

/** `12,5%` — a ratio from 0 to 1 as a percentage, with the same decimal comma as money. */
export function formatPercent(ratio: number, decimals = 1): string {
  return `${(ratio * 100).toFixed(decimals).replace('.', ',')}%`;
}
