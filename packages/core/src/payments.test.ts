import { describe, expect, it } from 'vitest';
import {
  clientPaidInFull,
  directionOf,
  sastDay,
  realisedMargin,
  validatePaymentInput,
  zarOf,
  type StoredPayment,
} from './payments.js';

/**
 * ARB-311 acceptance: "Realised margin matches hand calculation in tests". Every figure is
 * worked by hand beside it; the amounts and rates are test data, not anyone's fees.
 */
const TODAY = { today: '2026-09-23' };
const p = (
  kind: StoredPayment['kind'],
  amountMinor: number,
  currency = 'ZAR',
  amountZarMinor: number | null = null,
): StoredPayment => ({ kind, amountMinor, currency, amountZarMinor });

describe('realised margin', () => {
  it('is payments in less supplier payments, fees and other costs, for a rand job', () => {
    // In: R7 500,00 + R7 500,00 = R15 000,00. Supplier: R3 000,00 + R6 000,50 = R9 000,50.
    // Fee: R1 500,00. Margin: R15 000,00 − R9 000,50 − R1 500,00 = R4 499,50.
    const m = realisedMargin([
      p('client', 750_000),
      p('client', 750_000),
      p('supplier', 300_000),
      p('supplier', 600_050),
      p('platform_fee', 150_000),
    ]);
    expect(m).toEqual({
      inZarMinor: 1_500_000n,
      supplierZarMinor: 900_050n,
      feesZarMinor: 150_000n,
      otherZarMinor: 0n,
      marginZarMinor: 449_950n,
      unconverted: [],
    });
  });

  it('uses each payment’s stored rand figure, and leaves one without a rate out, listed', () => {
    // In: USD 500,00 at 18.25 = R9 125,00. Supplier: R5 000,00. Fee: USD 50,00 at 18.25 =
    // R912,50. Other: R100,00. Margin: R9 125,00 − R5 000,00 − R912,50 − R100,00 = R3 112,50.
    const unrated = p('client', 10_000, 'USD', null);
    const m = realisedMargin([
      p('client', 50_000, 'USD', 912_500),
      p('supplier', 500_000),
      p('platform_fee', 5_000, 'USD', 91_250),
      p('other_cost', 10_000),
      unrated,
    ]);
    expect(m.marginZarMinor).toBe(311_250n);
    expect(m.unconverted).toEqual([unrated]);
  });

  it('can be a loss', () => {
    // R1 000,00 in, R1 200,00 to the supplier: −R200,00.
    expect(realisedMargin([p('client', 100_000), p('supplier', 120_000)]).marginZarMinor).toBe(
      -20_000n,
    );
  });
});

describe('conversion and payment in full', () => {
  it('converts at the typed rate, rounded half up to the cent', () => {
    // USD 500,00 × 18.25 = R9 125,00. USD 0,01 × 18.255 = 18,255 cents → 18 cents.
    // USD 0,02 × 18.25 = 36,5 cents → 37 cents (half up).
    expect(zarOf(50_000, 'USD', '18.25')).toBe(912_500);
    expect(zarOf(1, 'USD', '18.255')).toBe(18);
    expect(zarOf(2, 'USD', '18.25')).toBe(37);
    expect(zarOf(150_000, 'ZAR', null)).toBe(150_000);
    expect(zarOf(150_000, 'USD', null)).toBeNull();
  });

  it('says a job is paid in full only on client payments in its own currency', () => {
    const paid = [p('client', 750_000), p('client', 750_000), p('supplier', 900_050)];
    expect(clientPaidInFull(paid, 1_500_000, 'ZAR')).toBe(true);
    expect(clientPaidInFull(paid.slice(0, 1), 1_500_000, 'ZAR')).toBe(false);
    expect(clientPaidInFull([p('client', 100_000, 'USD', 1_825_000)], 1_500_000, 'ZAR')).toBe(
      false,
    );
    expect(clientPaidInFull(paid, null, 'ZAR')).toBe(false);
    // 23/09/2026 22:30 UTC is 24/09/2026 00:30 SAST.
    expect(sastDay(new Date('2026-09-23T22:30:00Z'))).toBe('2026-09-24');
    expect(sastDay(new Date('2026-09-23T21:59:00Z'))).toBe('2026-09-23');
    expect(directionOf('client')).toBe('in');
    expect(directionOf('platform_fee')).toBe('out');
  });
});

describe('validatePaymentInput', () => {
  it('accepts a client payment in USD with its rate, upper-casing the currency', () => {
    expect(
      validatePaymentInput(
        {
          kind: 'client',
          amountMinor: 50_000,
          currency: 'usd',
          paidOn: '2026-09-22',
          fxRate: '18.25',
          reference: ' INV-001 ',
        },
        TODAY,
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'client',
        amountMinor: 50_000,
        currency: 'USD',
        paidOn: '2026-09-22',
        fxRate: '18.25',
        reference: 'INV-001',
        deliveryOrderId: null,
        milestoneIndex: null,
      },
    });
  });

  it('needs a delivery order for a supplier payment, and a milestone only there', () => {
    const order = 'aaaaaaaa-0000-4000-8000-000000000093';
    expect(
      validatePaymentInput(
        {
          kind: 'supplier',
          amountMinor: 300_000,
          currency: 'ZAR',
          paidOn: '2026-09-23',
          deliveryOrderId: order,
          milestoneIndex: 0,
        },
        TODAY,
      ),
    ).toMatchObject({ ok: true, value: { deliveryOrderId: order, milestoneIndex: 0 } });
    const result = validatePaymentInput(
      { kind: 'supplier', amountMinor: 300_000, currency: 'ZAR', paidOn: '2026-09-23' },
      TODAY,
    );
    expect(result).toMatchObject({ ok: false, errors: [{ field: 'deliveryOrderId' }] });
    expect(
      validatePaymentInput(
        {
          kind: 'platform_fee',
          amountMinor: 1,
          currency: 'ZAR',
          paidOn: '2026-09-23',
          milestoneIndex: 0,
        },
        TODAY,
      ),
    ).toMatchObject({ ok: false, errors: [{ field: 'milestoneIndex' }] });
  });

  it('names every bad field: kind, a fraction of a cent, currency, a future day, a rate on rand', () => {
    const result = validatePaymentInput(
      {
        kind: 'refund',
        amountMinor: 10.5,
        currency: 'rand',
        paidOn: '2026-09-24',
        fxRate: '-1',
        reference: 'x'.repeat(201),
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual([
      'kind',
      'amountMinor',
      'currency',
      'paidOn',
      'fxRate',
      'reference',
    ]);
    expect(
      validatePaymentInput(
        { kind: 'client', amountMinor: 1, currency: 'ZAR', paidOn: '2026-09-01', fxRate: '1' },
        TODAY,
      ),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'fxRate', message: 'is not needed for a payment in rand' }],
    });
    expect(
      validatePaymentInput(
        {
          kind: 'client',
          amountMinor: 1,
          currency: 'USD',
          paidOn: '2026-09-01',
          fxRate: '18.123456789',
        },
        TODAY,
      ),
    ).toMatchObject({ ok: false, errors: [{ field: 'fxRate' }] });
  });
});
