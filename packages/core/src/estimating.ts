import type { ScorableJob } from './scoring.js';

/**
 * The estimate worker's logic (ARB-040, docs/01 section E): "Classifies category;
 * estimate order: in-house capability → supplier rate card → market band p50 → AI-build
 * tier (website categories only)".
 *
 * Nothing in here holds a price. Every figure comes from a row the owner supplied — a
 * category ticked in-house (docs/02 D-04), a supplier's rate card, a market band (D-14),
 * or the rate card of a supplier on the `ai_build` channel — and the chosen method is
 * recorded with the estimate so a number on screen traces back to its row (05 section 3).
 */
export const ESTIMATE_METHODS = [
  'in_house',
  'rate_card',
  'market_band',
  'candidate_quote',
  'ai_build',
] as const;
export type EstimateMethod = (typeof ESTIMATE_METHODS)[number];

export const SUPPLIER_CHANNELS = [
  'freelancer',
  'upwork',
  'fiverr',
  'direct',
  'in_house',
  'ai_build',
] as const;
export type SupplierChannel = (typeof SUPPLIER_CHANNELS)[number];

/** Channels whose rate cards count as "supplier rate card": outside suppliers, of any kind. */
export const SUPPLIER_RATE_CARD_CHANNELS: readonly SupplierChannel[] = [
  'freelancer',
  'upwork',
  'fiverr',
  'direct',
];

/**
 * "AI-build tier (website categories only)". The AI-build pipeline is a template engine
 * for websites, costed as a supplier tier (docs/reference/R2 section on supplier options),
 * so it is offered only for categories whose deliverable is a website. Apps, games,
 * marketing and content are not websites, whatever tooling builds them.
 */
export const AI_BUILD_CATEGORIES = [
  'website-build',
  'wordpress',
  'elementor',
  'shopify',
  'landing-page',
] as const;

/**
 * When several bands exist for one category and currency, the one observed most directly
 * wins. A seed band is the last resort, and is flagged as such wherever it is shown.
 */
export const BAND_SOURCE_PRIORITY = [
  'completed_projects',
  'owner_csv',
  'marketplace_sample',
  'seed',
] as const;
export type BandSource = (typeof BAND_SOURCE_PRIORITY)[number];

// ---------------------------------------------------------------------------------------
// Classification

export interface CategoryOption {
  readonly slug: string;
  readonly name: string;
}

export interface ModelCategory {
  /** One of the slugs offered, or null when none fits. The schema allows nothing else. */
  readonly category_slug: string | null;
  readonly confidence: number;
  readonly reason: string;
}

/** The JSON schema the model is held to. The enum is the taxonomy, so it cannot invent a category. */
export function buildCategorySchema(slugs: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['category_slug', 'confidence', 'reason'],
    properties: {
      category_slug: { type: ['string', 'null'], enum: [...slugs, null] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', minLength: 3, maxLength: 240 },
    },
  } as const;
}

export const CLASSIFY_SYSTEM_PROMPT =
  'You classify freelance marketplace jobs into one service category for a small South ' +
  'African digital agency. Choose the single category that best describes the main ' +
  'deliverable the client is paying for, not the tools mentioned in passing. If no ' +
  'category fits, answer null rather than forcing one. Reply with JSON only.';

export type ClassifiableJob = Pick<ScorableJob, 'title' | 'description' | 'skills'>;

/** The classification prompt: the job and the taxonomy, and nothing about the client. */
export function buildClassifyPrompt(
  job: ClassifiableJob,
  categories: readonly CategoryOption[],
): string {
  return [
    'Classify this job into one of the categories below.',
    '',
    `Title: ${job.title}`,
    `Description:\n${job.description ?? '(none)'}`,
    `Skills: ${job.skills.length > 0 ? job.skills.join(', ') : 'none listed'}`,
    '',
    'Categories (slug: name):',
    ...categories.map((category) => `- ${category.slug}: ${category.name}`),
    '',
    'Return a JSON object with exactly these keys:',
    '- category_slug: one of the slugs above, or null if none fits',
    '- confidence: 0 to 1',
    '- reason: one short sentence',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Choosing an estimate

export interface RateCardSource {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly channel: SupplierChannel;
  readonly currency: string;
  readonly fixedPriceMinor: number | null;
  readonly hourlyRateMinor: number | null;
  readonly turnaroundDays: number | null;
}

export interface PriceBandSource {
  readonly id: string;
  readonly currency: string;
  readonly p25Minor: number;
  readonly p50Minor: number;
  readonly p75Minor: number;
  readonly sampleSize: number;
  readonly source: BandSource;
  /** ISO 8601. */
  readonly sampledAt: string;
}

export interface EstimateInputs {
  readonly category: { readonly slug: string; readonly inHouse: boolean };
  /** The job's currency. Only sources in the same currency are read; conversion is the margin engine's job. */
  readonly currency: string;
  /** An hourly job is priced per hour, from hourly rates; a fixed one from fixed prices. */
  readonly hourly: boolean;
  readonly rateCards: readonly RateCardSource[];
  readonly bands: readonly PriceBandSource[];
}

export interface EstimateChoice {
  readonly method: EstimateMethod;
  readonly currency: string;
  readonly lowMinor: number;
  readonly expectedMinor: number;
  readonly highMinor: number;
  readonly turnaroundDays: number | null;
  /** The supplier the figure came from, when exactly one did. */
  readonly supplierId: string | null;
  /** What the figure rests on, for the audit log (05 section 3.3). */
  readonly basis: Record<string, unknown>;
}

export interface EstimateDecision {
  readonly choice: EstimateChoice | null;
  /** One line per method, in order, saying why it did or did not apply. */
  readonly considered: readonly string[];
}

/**
 * The middle value of a list of minor units, in integer arithmetic. For an even count the
 * two middle values are averaged and rounded down, so the result is still whole minor units.
 */
export function medianMinor(values: readonly number[]): number {
  if (values.length === 0) throw new Error('medianMinor needs at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.floor((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function priceOf(card: RateCardSource, hourly: boolean): number | null {
  return hourly ? card.hourlyRateMinor : card.fixedPriceMinor;
}

function usableCards(inputs: EstimateInputs, channels: readonly SupplierChannel[]) {
  return inputs.rateCards.filter(
    (card) =>
      channels.includes(card.channel) &&
      card.currency === inputs.currency &&
      priceOf(card, inputs.hourly) !== null,
  );
}

function fromCards(
  method: EstimateMethod,
  cards: readonly RateCardSource[],
  inputs: EstimateInputs,
): EstimateChoice {
  const prices = cards.map((card) => priceOf(card, inputs.hourly)!);
  const turnarounds = cards
    .map((card) => card.turnaroundDays)
    .filter((days): days is number => days !== null);
  return {
    method,
    currency: inputs.currency,
    lowMinor: Math.min(...prices),
    expectedMinor: medianMinor(prices),
    highMinor: Math.max(...prices),
    turnaroundDays: turnarounds.length > 0 ? medianMinor(turnarounds) : null,
    supplierId: cards.length === 1 ? cards[0]!.supplierId : null,
    basis: {
      priced: inputs.hourly ? 'per_hour' : 'fixed',
      suppliers: cards.map((card) => ({
        id: card.supplierId,
        name: card.supplierName,
        channel: card.channel,
        priceMinor: priceOf(card, inputs.hourly),
        turnaroundDays: card.turnaroundDays,
      })),
    },
  };
}

function bestBand(bands: readonly PriceBandSource[]): PriceBandSource | null {
  const ranked = [...bands].sort((a, b) => {
    const byPriority =
      BAND_SOURCE_PRIORITY.indexOf(a.source) - BAND_SOURCE_PRIORITY.indexOf(b.source);
    if (byPriority !== 0) return byPriority;
    return b.sampledAt.localeCompare(a.sampledAt);
  });
  return ranked[0] ?? null;
}

const describeCards = (hourly: boolean, currency: string) =>
  `no active supplier has a ${currency} ${hourly ? 'hourly rate' : 'fixed price'} for this category`;

/**
 * Walks the four methods in the order the spec fixes and returns the first that has a
 * figure to stand on, with a note for each one passed over. Returns no choice at all
 * rather than a number from nowhere.
 */
export function chooseEstimate(inputs: EstimateInputs): EstimateDecision {
  const considered: string[] = [];
  const { currency, hourly } = inputs;

  const inHouse = usableCards(inputs, ['in_house']);
  if (!inputs.category.inHouse) {
    considered.push('in_house: category is not delivered in-house (docs/02 D-04)');
  } else if (inHouse.length === 0) {
    considered.push(`in_house: ${describeCards(hourly, currency)} on the in-house channel`);
  } else {
    return { choice: fromCards('in_house', inHouse, inputs), considered };
  }

  const suppliers = usableCards(inputs, SUPPLIER_RATE_CARD_CHANNELS);
  if (suppliers.length === 0) {
    considered.push(`rate_card: ${describeCards(hourly, currency)}`);
  } else {
    return { choice: fromCards('rate_card', suppliers, inputs), considered };
  }

  if (hourly) {
    considered.push(
      'market_band: bands are fixed-project prices, so an hourly job cannot use them',
    );
  } else {
    const band = bestBand(inputs.bands.filter((candidate) => candidate.currency === currency));
    if (!band) {
      considered.push(`market_band: no ${currency} band for this category (docs/BLOCKERS.md D-14)`);
    } else {
      return {
        choice: {
          method: 'market_band',
          currency,
          lowMinor: band.p25Minor,
          expectedMinor: band.p50Minor,
          highMinor: band.p75Minor,
          turnaroundDays: null,
          supplierId: null,
          basis: {
            bandId: band.id,
            source: band.source,
            isSeed: band.source === 'seed',
            sampleSize: band.sampleSize,
            sampledAt: band.sampledAt,
          },
        },
        considered,
      };
    }
  }

  const aiBuild = usableCards(inputs, ['ai_build']);
  if (!(AI_BUILD_CATEGORIES as readonly string[]).includes(inputs.category.slug)) {
    considered.push('ai_build: only website categories can be built by the AI-build tier');
  } else if (aiBuild.length === 0) {
    considered.push(`ai_build: ${describeCards(hourly, currency)} on the ai_build channel`);
  } else {
    return { choice: fromCards('ai_build', aiBuild, inputs), considered };
  }

  return { choice: null, considered };
}
