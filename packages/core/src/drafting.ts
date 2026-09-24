import type { ScorableJob } from './scoring.js';

/**
 * The draft-bid worker's rules (ARB-043, docs/01 sections E and H): "Builds bid from
 * template + job + client history + portfolio + real estimate + milestone split; queues
 * for approval". The model writes prose; this module decides everything a number or a
 * claim rests on. The price is the margin engine's, the timeline the estimate's, the
 * milestones sum to the price to the cent, and a citation can only be an item the
 * owner recorded (D-10) — the schema offers the model those ids and no others.
 */
export const PORTFOLIO_KINDS = ['own_work', 'labelled_demo'] as const;
export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

export interface DraftPortfolioItem {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly kind: PortfolioKind;
}

export interface ModelMilestone {
  readonly title: string;
  /** A share of the price, in whole percent. Shares are normalised, so they need not sum to 100. */
  readonly share: number;
}

export interface ModelDraft {
  readonly body: string;
  readonly delivery_days: number;
  readonly milestones: ModelMilestone[];
  readonly portfolio_item_ids: string[];
  /** For the operator's eyes, never the client's. */
  readonly operator_notes: string;
}

export const MAX_MILESTONES = 5;
export const MAX_CITATIONS = 3;

/**
 * Where a bid may be drafted and sent from here (ARB-300, docs/01 section B). Upwork is
 * read only: "Submission only via Upwork's agency/Business Manager model", and never a
 * logged-in browser session. Fiverr has no verified buyer API. So a job on either is
 * scored and priced like any other, and bid on at the marketplace itself.
 */
export const BID_PLATFORMS = ['freelancer'] as const;

/** Why a bid cannot be drafted here for a job on `platform`, or null when it can. */
export function readOnlyPlatformReason(platform: string): string | null {
  if ((BID_PLATFORMS as readonly string[]).includes(platform)) return null;
  const name = platform === 'upwork' ? 'Upwork' : platform === 'fiverr' ? 'Fiverr' : platform;
  return `${name} jobs are read only here: bid on ${name} itself (docs/01 section B).`;
}

/**
 * The JSON schema the model is held to. `portfolio_item_ids` is an enum of the offered
 * ids, so a made-up reference is rejected before it is read; with nothing offered the
 * list must be empty. The body may not carry a URL: links come from the cited items,
 * written in by code, never from the model.
 */
export function buildDraftSchema(portfolioIds: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'delivery_days', 'milestones', 'portfolio_item_ids', 'operator_notes'],
    properties: {
      body: { type: 'string', minLength: 80, maxLength: 3000, pattern: '^(?![\\s\\S]*https?://)' },
      delivery_days: { type: 'integer', minimum: 1, maximum: 365 },
      milestones: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_MILESTONES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'share'],
          properties: {
            title: { type: 'string', minLength: 2, maxLength: 80 },
            share: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      portfolio_item_ids:
        portfolioIds.length === 0
          ? { type: 'array', maxItems: 0 }
          : {
              type: 'array',
              uniqueItems: true,
              maxItems: MAX_CITATIONS,
              items: { type: 'string', enum: [...portfolioIds] },
            },
      operator_notes: { type: 'string', maxLength: 500 },
    },
  } as const;
}

export const DRAFT_SYSTEM_PROMPT =
  'You draft bids for a small South African digital agency on a freelance marketplace, ' +
  'writing as the agency in UK English. Follow the template for tone, structure, call to ' +
  'action and sign-off. Say only what the brief supports. Never invent past clients, ' +
  'results, reviews, team members or deadlines, never create urgency or scarcity, and ' +
  'never mention the agency’s costs, suppliers or margin. Refer to work only by the ' +
  'portfolio items offered, by their ids, and put no links in the body. Quote exactly the ' +
  'price and the delivery time given. Reply with JSON only.';

export interface DraftInput {
  readonly job: ScorableJob;
  readonly template: { readonly name: string; readonly body: string };
  readonly priceMinor: number;
  readonly currency: string;
  /** From the estimate when it has one. Otherwise the model proposes a timeline and it is flagged as proposed. */
  readonly deliveryDays: number | null;
  readonly portfolio: readonly DraftPortfolioItem[];
}

function money(minor: number, currency: string): string {
  const digits = String(Math.abs(minor)).padStart(3, '0');
  return `${minor < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
}

/** The drafting prompt: the job, the client's platform record, the template, the price, the timeline, the portfolio. No names, no costs. */
export function buildDraftPrompt(input: DraftInput): string {
  const { job } = input;
  const unit = job.hourly ? ' per hour' : '';
  const portfolio =
    input.portfolio.length === 0
      ? ['Portfolio items available to cite: none. Cite nothing.']
      : [
          'Portfolio items available to cite (id: title — description; kind):',
          ...input.portfolio.map(
            (item) =>
              `- ${item.id}: ${item.title}${item.description ? ` — ${item.description}` : ''}; ${
                item.kind === 'labelled_demo' ? 'a demo, to be labelled as such' : 'our own work'
              }`,
          ),
        ];
  return [
    'Draft a bid for this job.',
    '',
    `Title: ${job.title}`,
    `Description:\n${job.description ?? '(none)'}`,
    `Skills asked for: ${job.skills.length > 0 ? job.skills.join(', ') : 'none listed'}`,
    `Client budget: ${
      job.budgetMinMinor === null && job.budgetMaxMinor === null
        ? 'not stated'
        : `${job.budgetMinMinor === null ? '' : money(job.budgetMinMinor, job.currency ?? '')} to ${job.budgetMaxMinor === null ? '' : money(job.budgetMaxMinor, job.currency ?? '')}${unit}`.trim()
    }`,
    `Client on the platform: payment ${job.clientPaymentVerified === null ? 'unknown' : job.clientPaymentVerified ? 'verified' : 'not verified'}, rating ${job.clientRating ?? 'none'}, country ${job.clientCountry ?? 'unknown'}`,
    '',
    `Price to quote: ${money(input.priceMinor, input.currency)}${unit}. Quote this figure exactly.`,
    input.deliveryDays === null
      ? 'Delivery time: propose a realistic number of days for this scope; it will be shown to the operator as your proposal.'
      : `Delivery time: ${String(input.deliveryDays)} days. Quote this exactly.`,
    '',
    `Template "${input.template.name}" (tone, structure, call to action, sign-off):`,
    input.template.body,
    '',
    ...portfolio,
    '',
    'Return a JSON object with exactly these keys:',
    '- body: the bid text, 80 to 3000 characters, no links',
    '- delivery_days: integer',
    `- milestones: 1 to ${String(MAX_MILESTONES)} items of {title, share}, share in whole percent of the price`,
    `- portfolio_item_ids: up to ${String(MAX_CITATIONS)} of the ids offered, or an empty list`,
    '- operator_notes: anything the operator should check before approving, or an empty string',
  ].join('\n');
}

export interface Milestone {
  readonly title: string;
  readonly amount_minor: number;
  readonly share: number;
}

/**
 * Turns shares into amounts that sum to the price exactly. Shares are normalised, so
 * 30/30/30 is three thirds; each amount is rounded down and the last takes the remainder,
 * so the sum is the price to the cent (05 section 3.5) whatever the model's arithmetic.
 */
export function splitMilestones(
  amountMinor: number,
  milestones: readonly ModelMilestone[],
): Milestone[] {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('milestones need a positive whole amount in minor units');
  }
  if (milestones.length === 0) throw new Error('a proposal needs at least one milestone');
  const total = milestones.reduce((sum, m) => sum + m.share, 0);
  if (total <= 0) throw new Error('milestone shares must add up to more than nothing');

  const amounts = milestones.map((m) => Math.floor((amountMinor * m.share) / total));
  const assigned = amounts.reduce((sum, a) => sum + a, 0);
  amounts[amounts.length - 1] = (amounts[amounts.length - 1] ?? 0) + (amountMinor - assigned);

  return milestones.map((m, index) => ({
    title: m.title.trim(),
    amount_minor: amounts[index] ?? 0,
    share: m.share,
  }));
}

/** The client-facing text: the model's body, then the cited items written in by code. */
export function proposalBody(body: string, citations: readonly DraftPortfolioItem[]): string {
  if (citations.length === 0) return body.trim();
  const lines = citations.map((item) => {
    const label = item.kind === 'labelled_demo' ? ' (demo)' : '';
    return `- ${item.title}${label}${item.url ? `: ${item.url}` : ''}`;
  });
  return `${body.trim()}\n\nExamples of our work:\n${lines.join('\n')}`;
}
