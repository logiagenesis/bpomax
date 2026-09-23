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

/**
 * A marketplace amount, as its JSON gives it (`250`, `462.57575757575756`), as whole
 * minor units of its currency. The digits are worked as text, never multiplied as a
 * float; anything past the currency's minor digits is rounded half up.
 */
/** Digits after the decimal point for a currency, per ISO 4217: two unless listed. */
export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/**
 * An amount typed or imported as text — `1 500,00`, `1500.50`, `1,500`, `R 1500` —
 * as whole minor units in a string, so no float is ever involved. Spaces, no-break
 * spaces and a leading currency letter or symbol are ignored. A comma or dot followed
 * by one or two digits at the end is the decimal separator; one followed by three
 * digits is a thousands group. Null when the text is not an amount.
 */
export function parseAmountText(text: string, currency: string): string | null {
  const digits = minorDigits(currency);
  const cleaned = text
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/^[A-Za-z$€£R]+/, '')
    .trim();
  const match = /^(\d[\d.,]*)$/.exec(cleaned);
  if (!match) return null;
  let body = match[1] ?? '';
  let fraction = '';
  const tail = /([.,])(\d{1,2})$/.exec(body);
  if (tail && !/^\d{1,3}([.,]\d{3})+$/.test(body)) {
    fraction = tail[2] ?? '';
    body = body.slice(0, -(fraction.length + 1));
  }
  if (!/^\d{1,3}([.,]\d{3})*$/.test(body) && !/^\d+$/.test(body)) return null;
  const whole = body.replace(/[.,]/g, '');
  if (fraction.length > digits) return null;
  return String(BigInt(`${whole}${fraction.padEnd(digits, '0')}`));
}

export function toMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) throw new RangeError(`not an amount: ${String(amount)}`);
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new RangeError(`not a currency code: ${currency}`);
  const digits = MINOR_DIGITS[code] ?? 2;
  const negative = amount < 0;
  // The shortest decimal that reads back as this number is the text the JSON carried
  // (`1.005`, not the float's own expansion `1.00499…`). Exponent form only appears for
  // amounts under a millionth or over 10^21, which no budget is; it is rounded as written.
  const shortest = String(Math.abs(amount));
  const text = shortest.includes('e') ? Math.abs(amount).toFixed(20) : shortest;
  const [whole = '0', fraction = ''] = text.split('.');
  const kept = fraction.slice(0, digits).padEnd(digits, '0');
  const next = fraction.charAt(digits);
  let minor = BigInt(whole + kept);
  if (next !== '' && Number(next) >= 5) minor += 1n;
  const result = Number(negative ? -minor : minor);
  if (!Number.isSafeInteger(result)) throw new RangeError(`amount too large: ${String(amount)}`);
  return result;
}
