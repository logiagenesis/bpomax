import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  rankSuppliers,
  timeZoneOffsetMinutes,
  type RankableSupplier,
  type SourcingBrief,
} from './sourcing.js';

/**
 * ARB-201 acceptance: "Ranking deterministic and explained per supplier". Every score
 * below is hand-worked in the comments; the order is proven stable under a shuffle.
 */
const NOW = new Date('2026-09-23T10:00:00Z');
/** formatMoney groups with a no-break space; the expectations here are typed with a plain one. */
const plain = (text: string | undefined) => (text ?? '').replace(/\u00a0/g, ' ');

function supplier(
  partial: Partial<RankableSupplier> & { id: string; name: string },
): RankableSupplier {
  return {
    countryCode: 'ZA',
    timeZone: 'Africa/Johannesburg',
    channel: 'direct',
    qualityScore: null,
    onTimeRate: null,
    paysAfterDelivery: false,
    active: true,
    rateCards: [],
    ...partial,
  };
}

const BRIEF: SourcingBrief = {
  category: 'wordpress',
  // R10 000 to R20 000, fixed; deadline 20 days out, flexible.
  budget: { minMinor: 1000000, maxMinor: 2000000, currency: 'ZAR', type: 'fixed' },
  deadline: '2026-10-13',
  deadlineFixed: false,
};

describe('the helpers', () => {
  it('reads a zone’s offset from the platform and counts days to a deadline in SAST', () => {
    expect(timeZoneOffsetMinutes('Africa/Johannesburg', NOW)).toBe(120);
    expect(timeZoneOffsetMinutes('Asia/Kolkata', NOW)).toBe(330);
    expect(timeZoneOffsetMinutes('America/Sao_Paulo', NOW)).toBe(-180);
    expect(timeZoneOffsetMinutes('Mars/Olympus', NOW)).toBeNull();
    // 23/09 to 13/10 is 20 days.
    expect(daysUntil('2026-10-13', NOW)).toBe(20);
    // 23:30 UTC is already the 24th in SAST, so the 24th is 0 days away.
    expect(daysUntil('2026-09-24', new Date('2026-09-23T23:30:00Z'))).toBe(0);
    expect(daysUntil('2026-09-20', NOW)).toBe(-3);
  });
});

describe('rankSuppliers', () => {
  const thandi = supplier({
    id: 't',
    name: 'Thandi Web',
    qualityScore: '85.00',
    onTimeRate: '0.950',
    paysAfterDelivery: true,
    rateCards: [
      { currency: 'ZAR', fixedPriceMinor: '900000', hourlyRateMinor: null, turnaroundDays: 5 },
    ],
  });
  const nord = supplier({
    id: 'n',
    name: 'Studio Nord',
    countryCode: 'NO',
    timeZone: 'Europe/Oslo',
    channel: 'upwork',
    qualityScore: '60.00',
    onTimeRate: null,
    rateCards: [
      { currency: 'ZAR', fixedPriceMinor: '1500000', hourlyRateMinor: null, turnaroundDays: 30 },
    ],
  });
  const kolkata = supplier({
    id: 'k',
    name: 'Kolkata Devs',
    countryCode: 'IN',
    timeZone: 'Asia/Kolkata',
    channel: 'freelancer',
    paysAfterDelivery: true,
    rateCards: [
      { currency: 'ZAR', fixedPriceMinor: '3000000', hourlyRateMinor: null, turnaroundDays: null },
    ],
  });
  const usd = supplier({
    id: 'u',
    name: 'Dollar Shop',
    channel: 'fiverr',
    rateCards: [
      { currency: 'USD', fixedPriceMinor: '50000', hourlyRateMinor: null, turnaroundDays: 3 },
    ],
  });
  const noCard = supplier({ id: 'x', name: 'No Card' });
  const inactive = supplier({ ...thandi, id: 'i', name: 'Gone', active: false });
  const inHouse = supplier({ ...thandi, id: 'h', name: 'Ourselves', channel: 'in_house' });
  const hourlyOnly = supplier({
    id: 'o',
    name: 'Hourly Only',
    rateCards: [
      { currency: 'ZAR', fixedPriceMinor: null, hourlyRateMinor: '50000', turnaroundDays: 2 },
    ],
  });

  it('scores every part with the fixed weights and explains each in a sentence', () => {
    const { ranked, excluded } = rankSuppliers(BRIEF, [thandi, nord, kolkata], { now: NOW });
    expect(ranked.map((r) => r.name)).toEqual(['Thandi Web', 'Studio Nord', 'Kolkata Devs']);

    // Thandi: R9 000 under the R10 000 floor → 40; 5 days fit 20 → 20; quality 85 → 10 of 12,
    // 95 % on time → 8 of 8 → 18; same zone → 10; pays after → 10. Total 98.
    expect(ranked[0]).toMatchObject({
      supplierId: 't',
      score: 98,
      parts: { rate: 40, turnaround: 20, quality: 18, timeZone: 10, paysAfterDelivery: 10 },
      quotedPriceMinor: '900000',
      priced: 'fixed',
      currency: 'ZAR',
    });
    expect(ranked[0]?.reasons.map(plain)).toEqual([
      'R9 000,00 is within the budget R10 000,00 – R20 000,00',
      "5 days' turnaround fits the 20 days left to the deadline",
      'quality 85 of 100, 95 % on time',
      'the same time zone as Pretoria',
      'accepts payment after delivery',
    ]);

    // Nord: R15 000 is halfway up the range → 40 − 20 × ½ = 30; 30 days miss a flexible
    // deadline → 10; quality 60 → 7 of 12, no on-time → 0 → 7; Oslo is UTC+2 in September,
    // the same as SAST → 10; wants payment first → 0. Total 57.
    expect(ranked[1]).toMatchObject({
      supplierId: 'n',
      score: 57,
      parts: { rate: 30, turnaround: 10, quality: 7, timeZone: 10, paysAfterDelivery: 0 },
    });
    expect(plain(ranked[1]?.reasons[1])).toBe(
      "30 days' turnaround would miss the deadline by 10 days; the deadline is flexible",
    );
    expect(plain(ranked[1]?.reasons[2])).toBe('quality 60 of 100, no on-time rate recorded');

    // Kolkata: R30 000 is R10 000 over a R20 000 ceiling → 20 × (20 000 − 10 000) / 20 000 = 10;
    // no turnaround with a deadline → 5; nothing recorded → 0; +3:30 from SAST → 6; pays after → 10. Total 31.
    expect(ranked[2]).toMatchObject({
      supplierId: 'k',
      score: 31,
      parts: { rate: 10, turnaround: 5, quality: 0, timeZone: 6, paysAfterDelivery: 10 },
    });
    expect(plain(ranked[2]?.reasons[0])).toBe(
      'R30 000,00 is above the budget R10 000,00 – R20 000,00',
    );
    expect(plain(ranked[2]?.reasons[3])).toBe('3.5 hours from Pretoria');
    expect(excluded).toEqual([]);
  });

  it('lists every supplier it cannot rank, with the reason, and never guesses a conversion', () => {
    const { ranked, excluded } = rankSuppliers(
      BRIEF,
      [usd, noCard, inactive, inHouse, hourlyOnly, thandi],
      { now: NOW },
    );
    expect(ranked.map((r) => r.supplierId)).toEqual(['t']);
    expect(excluded).toEqual([
      {
        supplierId: 'u',
        name: 'Dollar Shop',
        reason: 'no ZAR rate card for wordpress; conversion is not guessed',
      },
      { supplierId: 'i', name: 'Gone', reason: 'inactive' },
      { supplierId: 'o', name: 'Hourly Only', reason: 'no fixed price for wordpress' },
      { supplierId: 'x', name: 'No Card', reason: 'no rate card for wordpress' },
      {
        supplierId: 'h',
        name: 'Ourselves',
        reason: 'on the in-house channel, which is not sourced',
      },
    ]);
  });

  it('is the same list whatever order the suppliers arrive in, and ties break by name', () => {
    const twinA = supplier({ ...thandi, id: 'a', name: 'Alpha' });
    const twinB = supplier({ ...thandi, id: 'b', name: 'Beta' });
    const one = rankSuppliers(BRIEF, [nord, twinB, kolkata, twinA, thandi], { now: NOW });
    const two = rankSuppliers(BRIEF, [thandi, twinA, kolkata, twinB, nord], { now: NOW });
    expect(one).toEqual(two);
    expect(one.ranked.map((r) => r.name)).toEqual([
      'Alpha',
      'Beta',
      'Thandi Web',
      'Studio Nord',
      'Kolkata Devs',
    ]);
  });

  it('a brief without a budget gives half marks for the rate and says so; a fixed deadline missed scores nothing', () => {
    const open: SourcingBrief = {
      category: 'wordpress',
      budget: { minMinor: null, maxMinor: null, currency: null, type: null },
      deadline: '2026-09-30',
      deadlineFixed: true,
    };
    const { ranked } = rankSuppliers(open, [nord, usd], { now: NOW });
    // Nord: 20 for the rate; 30 days miss a fixed deadline 7 days out → 0; 7; 10; 0 → 37.
    // Dollar Shop (USD, no currency on the brief so any counts): 20; 3 days fit → 20; 0; 10; 0 → 50.
    expect(ranked.map((r) => [r.name, r.score])).toEqual([
      ['Dollar Shop', 50],
      ['Studio Nord', 37],
    ]);
    expect(plain(ranked[1]?.reasons[0])).toBe(
      'R15 000,00; the brief has no budget to compare it with',
    );
    expect(plain(ranked[1]?.reasons[1])).toBe(
      "30 days' turnaround would miss the fixed deadline by 23 days",
    );
    expect(plain(ranked[0]?.reasons[0])).toBe(
      'USD 500,00; the brief has no budget to compare it with',
    );
  });

  it('an hourly brief is priced by hourly rates, against the budget per hour', () => {
    const hourly: SourcingBrief = {
      category: 'wordpress',
      budget: { minMinor: 40000, maxMinor: 60000, currency: 'ZAR', type: 'hourly' },
      deadline: null,
      deadlineFixed: null,
    };
    const { ranked, excluded } = rankSuppliers(hourly, [hourlyOnly, thandi], { now: NOW });
    // Hourly Only: R500 an hour is over the R400 floor, halfway to R600 → 30; no deadline → 10;
    // nothing recorded → 0; same zone → 10; pays first → 0. Total 50.
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      name: 'Hourly Only',
      score: 50,
      priced: 'hourly',
      quotedPriceMinor: '50000',
    });
    expect(plain(ranked[0]?.reasons[0])).toBe(
      'R500,00 an hour is within the budget R400,00 – R600,00 an hour',
    );
    expect(plain(ranked[0]?.reasons[1])).toBe("2 days' turnaround; the brief has no deadline");
    expect(excluded).toEqual([
      { supplierId: 't', name: 'Thandi Web', reason: 'no hourly rate for wordpress' },
    ]);
  });
});
