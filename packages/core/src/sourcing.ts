import { SUPPLIER_RATE_CARD_CHANNELS, type SupplierChannel } from './estimating.js';
import { formatMoney } from './money.js';

/**
 * Ranking existing suppliers for a locked brief (ARB-201, docs/01 section E: the
 * sourcing worker "ranks existing suppliers"; section D step 5: "show country, time
 * zone, rate, turnaround, quality history"). The score is five parts with fixed weights
 * that sum to 100, every part explained in a sentence per supplier, and the order is
 * fixed by score then name, so the same inputs always give the same list. A supplier
 * that cannot be ranked is listed apart with the reason. Nothing here invents a rate:
 * every price is a rate card the owner imported (ARB-200, D-09).
 */
export const SOURCING_WEIGHTS = {
  rate: 40,
  turnaround: 20,
  quality: 20,
  timeZone: 10,
  paysAfterDelivery: 10,
} as const;

/** The organisation's own zone (docs/01: Pretoria; SAST is UTC+2 all year). */
export const HOME_TIME_ZONE = 'Africa/Johannesburg';

export interface RankableRateCard {
  readonly currency: string;
  /** Whole minor units as text (no float), or null. */
  readonly fixedPriceMinor: string | null;
  readonly hourlyRateMinor: string | null;
  readonly turnaroundDays: number | null;
}

export interface RankableSupplier {
  readonly id: string;
  readonly name: string;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly channel: SupplierChannel;
  /** `0.00` to `100.00` as text, or null. */
  readonly qualityScore: string | null;
  /** `0.000` to `1.000` as text, or null. */
  readonly onTimeRate: string | null;
  readonly paysAfterDelivery: boolean;
  readonly active: boolean;
  /** The supplier's rate cards in the brief's category, any currency. */
  readonly rateCards: readonly RankableRateCard[];
}

export interface SourcingBrief {
  readonly category: string;
  readonly budget: {
    readonly minMinor: number | null;
    readonly maxMinor: number | null;
    readonly currency: string | null;
    readonly type: 'fixed' | 'hourly' | null;
  };
  /** ISO `YYYY-MM-DD`, or null. */
  readonly deadline: string | null;
  readonly deadlineFixed: boolean | null;
}

export interface RankingParts {
  readonly rate: number;
  readonly turnaround: number;
  readonly quality: number;
  readonly timeZone: number;
  readonly paysAfterDelivery: number;
}

export interface RankedSupplier {
  readonly supplierId: string;
  readonly name: string;
  readonly channel: SupplierChannel;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly currency: string;
  /** The rate card price the brief is priced by, whole minor units as text. */
  readonly quotedPriceMinor: string;
  readonly priced: 'fixed' | 'hourly';
  readonly turnaroundDays: number | null;
  /** 0 to 100, whole. */
  readonly score: number;
  readonly parts: RankingParts;
  /** One sentence per part, in the parts' order. */
  readonly reasons: string[];
}

export interface ExcludedSupplier {
  readonly supplierId: string;
  readonly name: string;
  readonly reason: string;
}

export interface Ranking {
  readonly ranked: RankedSupplier[];
  readonly excluded: ExcludedSupplier[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The zone's UTC offset in minutes at `at`, from the platform's own zone data; null for a name it does not know. */
export function timeZoneOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!parts) return null;
    if (parts === 'GMT') return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(parts);
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
  } catch {
    return null;
  }
}

/** Whole days from the start of `now`'s SAST day to the deadline's day; negative when past. */
export function daysUntil(deadlineIso: string, now: Date): number {
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const today = Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate());
  const [y, m, d] = deadlineIso.split('-').map(Number);
  const deadline = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  return Math.round((deadline - today) / DAY_MS);
}

function money(minor: string | number, currency: string): string {
  return formatMoney(BigInt(minor), currency);
}

/**
 * Rate: 40 when the price is at or under the budget's lower end (or its only figure),
 * sliding to 20 at the upper end, then to 0 at twice the upper end. With no budget the
 * price is shown and half marks are given, so a brief without a figure still ranks by
 * everything else.
 */
function rateScore(
  price: bigint,
  currency: string,
  priced: 'fixed' | 'hourly',
  budget: SourcingBrief['budget'],
): { score: number; reason: string } {
  const unit = priced === 'hourly' ? ' an hour' : '';
  const shown = `${money(price.toString(), currency)}${unit}`;
  const min = budget.minMinor === null ? null : BigInt(budget.minMinor);
  const max = budget.maxMinor === null ? null : BigInt(budget.maxMinor);
  const low = min ?? max;
  const high = max ?? min;
  if (low === null || high === null) {
    return {
      score: SOURCING_WEIGHTS.rate / 2,
      reason: `${shown}; the brief has no budget to compare it with`,
    };
  }
  const range =
    min !== null && max !== null && min !== max
      ? `${money(min.toString(), currency)} – ${money(max.toString(), currency)}${unit}`
      : `${money(high.toString(), currency)}${unit}`;
  if (price <= low)
    return { score: SOURCING_WEIGHTS.rate, reason: `${shown} is within the budget ${range}` };
  if (price <= high) {
    // 40 at the low end sliding to 20 at the high end, in whole marks.
    const span = high - low;
    const into = price - low;
    const score = Number(
      (BigInt(SOURCING_WEIGHTS.rate) * span - BigInt(SOURCING_WEIGHTS.rate / 2) * into) / span,
    );
    return { score, reason: `${shown} is within the budget ${range}` };
  }
  const over = price - high;
  if (over >= high) return { score: 0, reason: `${shown} is more than twice the budget ${range}` };
  const score = Number((BigInt(SOURCING_WEIGHTS.rate / 2) * (high - over)) / high);
  return { score, reason: `${shown} is above the budget ${range}` };
}

function turnaroundScore(
  days: number | null,
  brief: SourcingBrief,
  now: Date,
): { score: number; reason: string } {
  const w = SOURCING_WEIGHTS.turnaround;
  if (brief.deadline === null) {
    return {
      score: w / 2,
      reason:
        days === null
          ? 'no turnaround recorded and no deadline in the brief'
          : `${String(days)} days' turnaround; the brief has no deadline`,
    };
  }
  const left = daysUntil(brief.deadline, now);
  if (days === null)
    return {
      score: w / 4,
      reason: `no turnaround recorded; ${String(left)} days left to the deadline`,
    };
  if (days <= left)
    return {
      score: w,
      reason: `${String(days)} days' turnaround fits the ${String(left)} days left to the deadline`,
    };
  if (brief.deadlineFixed === true) {
    return {
      score: 0,
      reason: `${String(days)} days' turnaround would miss the fixed deadline by ${String(days - left)} days`,
    };
  }
  return {
    score: w / 2,
    reason: `${String(days)} days' turnaround would miss the deadline by ${String(days - left)} days; the deadline is flexible`,
  };
}

function qualityScore(supplier: RankableSupplier): { score: number; reason: string } {
  const quality = supplier.qualityScore === null ? null : Number(supplier.qualityScore);
  const onTime = supplier.onTimeRate === null ? null : Number(supplier.onTimeRate);
  // 12 marks for the quality score, 8 for the on-time rate.
  const fromQuality = quality === null ? 0 : Math.round((quality * 12) / 100);
  const fromOnTime = onTime === null ? 0 : Math.round(onTime * 8);
  const reason = [
    quality === null
      ? 'no quality score recorded'
      : `quality ${supplier.qualityScore?.replace(/\.?0+$/, '')} of 100`,
    onTime === null ? 'no on-time rate recorded' : `${String(Math.round(onTime * 100))} % on time`,
  ].join(', ');
  return { score: fromQuality + fromOnTime, reason };
}

function timeZoneScore(timeZone: string | null, now: Date): { score: number; reason: string } {
  if (timeZone === null) return { score: 0, reason: 'no time zone recorded' };
  const theirs = timeZoneOffsetMinutes(timeZone, now);
  const home = timeZoneOffsetMinutes(HOME_TIME_ZONE, now);
  if (theirs === null || home === null)
    return { score: 0, reason: `time zone ${timeZone} is not known` };
  const hours = Math.abs(theirs - home) / 60;
  const shown =
    hours === 0
      ? 'the same time zone as Pretoria'
      : `${String(hours)} hour${hours === 1 ? '' : 's'} from Pretoria`;
  if (hours <= 2) return { score: 10, reason: shown };
  if (hours <= 5) return { score: 6, reason: shown };
  if (hours <= 8) return { score: 3, reason: shown };
  return { score: 0, reason: shown };
}

/**
 * Ranks the suppliers that can deliver the brief's category. Deterministic: score
 * descending, then name, then id. Every excluded supplier is listed with its reason.
 */
export function rankSuppliers(
  brief: SourcingBrief,
  suppliers: readonly RankableSupplier[],
  options: { readonly now: Date },
): Ranking {
  const ranked: RankedSupplier[] = [];
  const excluded: ExcludedSupplier[] = [];
  const priced: 'fixed' | 'hourly' = brief.budget.type === 'hourly' ? 'hourly' : 'fixed';
  for (const s of suppliers) {
    const out = (reason: string) => excluded.push({ supplierId: s.id, name: s.name, reason });
    if (!s.active) {
      out('inactive');
      continue;
    }
    if (!SUPPLIER_RATE_CARD_CHANNELS.includes(s.channel)) {
      out(
        `on the ${s.channel === 'in_house' ? 'in-house' : 'AI-build'} channel, which is not sourced`,
      );
      continue;
    }
    const cards = s.rateCards.filter(
      (card) => brief.budget.currency === null || card.currency === brief.budget.currency,
    );
    if (s.rateCards.length === 0) {
      out(`no rate card for ${brief.category}`);
      continue;
    }
    if (cards.length === 0) {
      out(
        `no ${brief.budget.currency ?? ''} rate card for ${brief.category}; conversion is not guessed`,
      );
      continue;
    }
    const withPrice = cards.filter((card) =>
      priced === 'hourly' ? card.hourlyRateMinor !== null : card.fixedPriceMinor !== null,
    );
    const card = withPrice[0];
    if (!card) {
      out(`no ${priced === 'hourly' ? 'hourly rate' : 'fixed price'} for ${brief.category}`);
      continue;
    }
    const priceText = (priced === 'hourly' ? card.hourlyRateMinor : card.fixedPriceMinor) as string;
    const rate = rateScore(BigInt(priceText), card.currency, priced, brief.budget);
    const turnaround = turnaroundScore(card.turnaroundDays, brief, options.now);
    const quality = qualityScore(s);
    const zone = timeZoneScore(s.timeZone, options.now);
    const pays = s.paysAfterDelivery
      ? { score: SOURCING_WEIGHTS.paysAfterDelivery, reason: 'accepts payment after delivery' }
      : { score: 0, reason: 'wants payment before delivery' };
    const parts: RankingParts = {
      rate: rate.score,
      turnaround: turnaround.score,
      quality: quality.score,
      timeZone: zone.score,
      paysAfterDelivery: pays.score,
    };
    ranked.push({
      supplierId: s.id,
      name: s.name,
      channel: s.channel,
      countryCode: s.countryCode,
      timeZone: s.timeZone,
      currency: card.currency,
      quotedPriceMinor: priceText,
      priced,
      turnaroundDays: card.turnaroundDays,
      score:
        parts.rate + parts.turnaround + parts.quality + parts.timeZone + parts.paysAfterDelivery,
      parts,
      reasons: [rate.reason, turnaround.reason, quality.reason, zone.reason, pays.reason],
    });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.localeCompare(b.name, 'en') ||
      a.supplierId.localeCompare(b.supplierId),
  );
  excluded.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.supplierId.localeCompare(b.supplierId),
  );
  return { ranked, excluded };
}
