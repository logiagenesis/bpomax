import { convertMinor, formatMoney, formatPercent, type FxQuote } from '@arbitron/core';
import type { Queryable } from '@arbitron/db';
import type { TelegramButton } from './api.js';

/**
 * The approval card (ARB-050, docs/01 section I): "Each approval card shows the item,
 * score, estimated cost, projected margin in ZAR and deal currency, and buttons Approve /
 * Edit / Reject". Every figure is read from a stored row (05 section 3.3); nothing is
 * computed here except the ZAR conversion at the rate the margin evaluation stored.
 */
export interface Card {
  readonly proposalId: string;
  readonly status: string;
  readonly jobTitle: string;
  readonly score: number | null;
  readonly verdict: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly deliveryDays: number;
  readonly milestoneCount: number;
  readonly estimate: {
    readonly expectedMinor: number;
    readonly currency: string;
    readonly method: string;
  } | null;
  readonly margin: {
    readonly marginMinor: number;
    readonly marginPct: string;
    readonly currency: string;
    readonly fxRateUsed: string | null;
  } | null;
  readonly body: string;
}

interface CardRow {
  id: string;
  status: string;
  title: string;
  amount_minor: string;
  currency: string;
  delivery_days: number;
  milestones: unknown[];
  body: string;
  score: number | null;
  verdict: string | null;
  expected_minor: string | null;
  estimate_currency: string | null;
  method: string | null;
  margin_minor: string | null;
  margin_pct: string | null;
  margin_currency: string | null;
  fx_rate_used: string | null;
}

export async function loadCard(db: Queryable, proposalId: string): Promise<Card | null> {
  const { rows } = await db.query<CardRow>(
    `select p.id, p.status, j.title, p.amount_minor::text, p.currency, p.delivery_days, p.milestones, p.body,
            s.score, s.verdict::text as verdict,
            e.expected_minor::text, e.currency as estimate_currency, e.method::text as method,
            m.margin_minor::text, m.margin_pct::text, m.currency as margin_currency, m.fx_rate_used::text
     from proposals p
     join jobs j on j.id = p.job_id
     left join lateral (
       select score, verdict from job_scores where job_id = p.job_id order by created_at desc limit 1
     ) s on true
     left join margin_evaluations m on m.id = p.margin_evaluation_id
     left join delivery_estimates e on e.id = m.delivery_estimate_id
     where p.id = $1`,
    [proposalId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    proposalId: row.id,
    status: row.status,
    jobTitle: row.title,
    score: row.score,
    verdict: row.verdict,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    deliveryDays: row.delivery_days,
    milestoneCount: Array.isArray(row.milestones) ? row.milestones.length : 0,
    estimate:
      row.expected_minor === null || row.estimate_currency === null || row.method === null
        ? null
        : {
            expectedMinor: Number(row.expected_minor),
            currency: row.estimate_currency,
            method: row.method,
          },
    margin:
      row.margin_minor === null || row.margin_pct === null || row.margin_currency === null
        ? null
        : {
            marginMinor: Number(row.margin_minor),
            marginPct: row.margin_pct,
            currency: row.margin_currency,
            fxRateUsed: row.fx_rate_used,
          },
    body: row.body,
  };
}

const METHOD_WORDS: Record<string, string> = {
  in_house: 'in-house',
  rate_card: 'rate card',
  market_band: 'market band',
  candidate_quote: 'quote',
  ai_build: 'AI build',
};

/** The margin in ZAR at the rate the evaluation stored, or a plain statement that there is none. */
export function marginInZar(margin: NonNullable<Card['margin']>): string {
  if (margin.currency === 'ZAR') return formatMoney(margin.marginMinor, 'ZAR');
  if (!margin.fxRateUsed) return 'no ZAR rate stored';
  const quote: FxQuote = {
    rate: margin.fxRateUsed,
    from: margin.currency,
    to: 'ZAR',
    at: '',
    source: '',
  };
  return formatMoney(convertMinor(margin.marginMinor, quote), 'ZAR');
}

const BODY_PREVIEW = 400;

export function renderCard(card: Card): string {
  const unit =
    card.milestoneCount === 0
      ? ''
      : ` · ${String(card.milestoneCount)} milestone${card.milestoneCount === 1 ? '' : 's'}`;
  const lines = [
    `Bid for approval — ${card.status}`,
    card.jobTitle,
    `Score: ${card.score === null ? 'not scored' : `${String(card.score)} (${card.verdict ?? '?'})`}`,
    `Price: ${formatMoney(card.amountMinor, card.currency)} · ${String(card.deliveryDays)} days${unit}`,
    `Estimated cost: ${
      card.estimate
        ? `${formatMoney(card.estimate.expectedMinor, card.estimate.currency)} (${METHOD_WORDS[card.estimate.method] ?? card.estimate.method})`
        : 'no estimate'
    }`,
    `Projected margin: ${
      card.margin
        ? `${formatMoney(card.margin.marginMinor, card.margin.currency)} (${formatPercent(Number(card.margin.marginPct) / 100)})` +
          (card.margin.currency === 'ZAR' ? '' : ` · ${marginInZar(card.margin)}`)
        : 'not evaluated'
    }`,
    '',
    card.body.length > BODY_PREVIEW ? `${card.body.slice(0, BODY_PREVIEW - 1)}…` : card.body,
  ];
  return lines.join('\n');
}

export function cardButtons(proposalId: string): TelegramButton[][] {
  return [
    [
      { text: 'Approve', callbackData: `approve:${proposalId}` },
      { text: 'Edit', callbackData: `edit:${proposalId}` },
      { text: 'Reject', callbackData: `reject:${proposalId}` },
    ],
  ];
}
