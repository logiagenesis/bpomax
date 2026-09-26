import { formatMoney } from './money.js';

/**
 * Rand prices shown VAT-inclusive (ARB-513, the owner's audit E-07; docs/01 section G:
 * "all ZAR prices shown to the operator VAT-inclusive at 15% where VAT applies").
 *
 * The prices are the amounts the org charges a client in rand: a bid, a deal's value, a
 * retainer. They are stored as the margin engine made them, without VAT, and shown here
 * with the VAT added at the org's rate (`settings.vat_pct`, 15 unless the owner changes
 * it), beside the amount without VAT. A rate of 0 is how an org says VAT does not apply
 * to it: the price is then shown as stored. Costs, estimates, margins and payments
 * received are not prices and are not changed (D-082).
 *
 * Nothing here is a float: the rate is read as thousandths of a percent, and the result
 * is rounded half away from zero to the cent.
 */

/** A rate as `settings.vat_pct` gives it (`"15.000"`), or a number, as thousandths of a percent. */
export function vatThousandths(pct: string | number): number | null {
  const text = typeof pct === 'number' ? String(pct) : pct.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
}

/** The amount with VAT added at the rate, in the same minor units. */
export function withVat(netMinor: number | bigint, vatPct: string | number): bigint {
  const thousandths = vatThousandths(vatPct);
  if (thousandths === null) throw new RangeError(`not a VAT rate: ${String(vatPct)}`);
  const scale = 100_000n;
  const numerator = BigInt(netMinor) * (scale + BigInt(thousandths));
  const quotient = numerator / scale;
  const remainder = numerator % scale;
  const away = (remainder < 0n ? -remainder : remainder) * 2n >= scale;
  return away ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
}

/** `15%`, `15,5%`: the rate as the page writes a percentage. */
export function formatVatRate(vatPct: string | number): string {
  const thousandths = vatThousandths(vatPct);
  if (thousandths === null) throw new RangeError(`not a VAT rate: ${String(vatPct)}`);
  const whole = Math.trunc(thousandths / 1000);
  const fraction = String(thousandths % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${String(whole)}${fraction ? `,${fraction}` : ''}%`;
}

/**
 * A price for the operator: in rand with VAT, `R1 150,00 incl. 15% VAT (R1 000,00
 * excl.)`; in any other currency, or where no VAT applies or no rate is known, as stored.
 */
export function formatPrice(
  netMinor: number | bigint,
  currency: string,
  vatPct: string | number | null | undefined,
): string {
  const thousandths = vatPct === null || vatPct === undefined ? null : vatThousandths(vatPct);
  if (currency.toUpperCase() !== 'ZAR' || thousandths === null || thousandths === 0) {
    return formatMoney(netMinor, currency);
  }
  return `${formatMoney(withVat(netMinor, thousandths / 1000), 'ZAR')} incl. ${formatVatRate(
    thousandths / 1000,
  )} VAT (${formatMoney(netMinor, 'ZAR')} excl.)`;
}
