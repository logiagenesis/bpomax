import { convertMinor, FX_RATE_SCALE, HOME_CURRENCY, parseDecimal } from './margin.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Payments and realised margin (ARB-311, docs/05 section 3.5: "payments in − payments
 * out − fees = realised margin"). A client pays in; a supplier, a platform fee or another
 * cost is paid out. Every amount is whole minor units of its own currency, and a payment
 * not in rand carries the rate it was converted at and when (05 section 3.4); a payment
 * without one is listed as unconverted, never guessed into rand.
 */
export const PAYMENT_KINDS = ['client', 'supplier', 'platform_fee', 'other_cost'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const MAX_PAYMENT_REFERENCE = 200;

/** The SAST calendar day of an instant, as ISO `YYYY-MM-DD` (SAST is UTC+2, with no summer time). */
export function sastDay(now: Date): string {
  return new Date(now.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
}

export function directionOf(kind: PaymentKind): 'in' | 'out' {
  return kind === 'client' ? 'in' : 'out';
}

export interface PaymentInput {
  readonly kind: PaymentKind;
  readonly amountMinor: number;
  readonly currency: string;
  /** ISO `YYYY-MM-DD`, the day it was paid (SAST). */
  readonly paidOn: string;
  /** Units of ZAR per one unit of `currency`, as typed or from the FX provider; null for ZAR. */
  readonly fxRate: string | null;
  readonly reference: string | null;
  readonly deliveryOrderId: string | null;
  readonly milestoneIndex: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE = /^\d+(\.\d{1,8})?$/;

function realDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

/**
 * Reads a payment as the page and the API both check it. `today` is the SAST day the
 * check runs on: a payment is recorded once made, so a day after it is refused. A rate is
 * optional here because the API may take one from the FX provider; the API refuses a
 * non-rand payment that ends up with neither.
 */
export function validatePaymentInput(
  input: unknown,
  options: { readonly today: string },
): ValidationResult<PaymentInput> {
  const errors: FieldError[] = [];
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const kind = raw.kind as PaymentKind;
  if (!PAYMENT_KINDS.includes(kind))
    errors.push({ field: 'kind', message: `must be one of ${PAYMENT_KINDS.join(', ')}` });

  const amount = raw.amountMinor;
  const amountOk = typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
  if (!amountOk) errors.push({ field: 'amountMinor', message: 'must be whole cents above 0' });

  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency))
    errors.push({ field: 'currency', message: 'must be a three-letter currency code' });

  const paidOn = typeof raw.paidOn === 'string' ? raw.paidOn : '';
  if (!realDate(paidOn)) errors.push({ field: 'paidOn', message: 'must be a real date' });
  else if (paidOn > options.today)
    errors.push({
      field: 'paidOn',
      message: 'must not be after today: record a payment once it is made',
    });

  let fxRate: string | null = null;
  if (raw.fxRate !== undefined && raw.fxRate !== null && raw.fxRate !== '') {
    const text = typeof raw.fxRate === 'string' ? raw.fxRate.trim() : String(raw.fxRate);
    if (currency === HOME_CURRENCY)
      errors.push({ field: 'fxRate', message: 'is not needed for a payment in rand' });
    else if (!RATE.test(text) || parseDecimal(text, FX_RATE_SCALE) <= 0n)
      errors.push({
        field: 'fxRate',
        message: 'must be a rate above 0 with at most 8 decimals, such as 18.25',
      });
    else fxRate = text;
  }

  let reference: string | null = null;
  if (typeof raw.reference === 'string' && raw.reference.trim() !== '') {
    reference = raw.reference.trim();
    if (reference.length > MAX_PAYMENT_REFERENCE)
      errors.push({
        field: 'reference',
        message: `must be ${String(MAX_PAYMENT_REFERENCE)} characters or fewer`,
      });
  }

  let deliveryOrderId: string | null = null;
  let milestoneIndex: number | null = null;
  if (kind === 'supplier') {
    if (typeof raw.deliveryOrderId !== 'string' || !UUID.test(raw.deliveryOrderId))
      errors.push({
        field: 'deliveryOrderId',
        message: 'a supplier is paid against a delivery order',
      });
    else deliveryOrderId = raw.deliveryOrderId;
    if (raw.milestoneIndex !== undefined && raw.milestoneIndex !== null) {
      const index = raw.milestoneIndex;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
        errors.push({ field: 'milestoneIndex', message: 'must be a milestone of the order' });
      else milestoneIndex = index;
    }
  } else if (raw.milestoneIndex !== undefined && raw.milestoneIndex !== null) {
    errors.push({ field: 'milestoneIndex', message: 'is only for a payment to the supplier' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      amountMinor: amount as number,
      currency,
      paidOn,
      fxRate,
      reference,
      deliveryOrderId,
      milestoneIndex,
    },
  };
}

/** The payment in rand: itself when in rand, converted at its rate otherwise, or null without one. */
export function zarOf(amountMinor: number, currency: string, fxRate: string | null): number | null {
  if (currency === HOME_CURRENCY) return amountMinor;
  if (fxRate === null) return null;
  return convertMinor(amountMinor, {
    rate: fxRate,
    from: currency,
    to: HOME_CURRENCY,
    at: '',
    source: '',
  });
}

export interface StoredPayment {
  readonly kind: PaymentKind;
  readonly amountMinor: number;
  readonly currency: string;
  /** The stored rand figure (`amount_zar_minor`), or null when there is none. */
  readonly amountZarMinor: number | null;
}

export interface RealisedMargin {
  /** Client payments, in rand. */
  readonly inZarMinor: bigint;
  /** Supplier payments, in rand. */
  readonly supplierZarMinor: bigint;
  /** Platform fees, in rand. */
  readonly feesZarMinor: bigint;
  /** Other costs, in rand. */
  readonly otherZarMinor: bigint;
  /** in − supplier − fees − other: docs/05 section 3.5's "payments in − payments out − fees". */
  readonly marginZarMinor: bigint;
  /** Payments not in rand with no rate stored: counted, never guessed into rand. */
  readonly unconverted: readonly StoredPayment[];
}

/** Realised margin over a job's payments, summed as BigInt. */
export function realisedMargin(payments: readonly StoredPayment[]): RealisedMargin {
  let inZar = 0n;
  let supplier = 0n;
  let fees = 0n;
  let other = 0n;
  const unconverted: StoredPayment[] = [];
  for (const p of payments) {
    const zar = p.currency === HOME_CURRENCY ? p.amountMinor : p.amountZarMinor;
    if (zar === null) {
      unconverted.push(p);
      continue;
    }
    const value = BigInt(zar);
    if (p.kind === 'client') inZar += value;
    else if (p.kind === 'supplier') supplier += value;
    else if (p.kind === 'platform_fee') fees += value;
    else other += value;
  }
  return {
    inZarMinor: inZar,
    supplierZarMinor: supplier,
    feesZarMinor: fees,
    otherZarMinor: other,
    marginZarMinor: inZar - supplier - fees - other,
    unconverted,
  };
}

/**
 * Whether the client has paid the job's agreed value, counting only client payments in
 * the job's own currency: a payment in another currency is not converted to decide it.
 */
export function clientPaidInFull(
  payments: readonly StoredPayment[],
  valueMinor: number | null,
  currency: string | null,
): boolean {
  if (valueMinor === null || currency === null || valueMinor <= 0) return false;
  const paid = payments
    .filter((p) => p.kind === 'client' && p.currency === currency)
    .reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
  return paid >= BigInt(valueMinor);
}
