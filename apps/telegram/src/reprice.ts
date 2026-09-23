import { formatMoney, formatPercent } from '@arbitron/core';
import type { Queryable } from '@arbitron/db';
import type { RepriceAlert } from '@arbitron/workers';
import type { BotDeps } from './engine.js';

/**
 * The operator alert for a real quote that breaks the margin rule (ARB-204, docs/01
 * section E "reprice"): a plain card to every linked chat of an owner or operator in the
 * org. It reads the evaluation the reprice worker stored, so every figure on it is the
 * stored one: the quote, the margin and the org's rule as it stood when judged.
 */
export interface RepriceCard {
  readonly jobTitle: string | null;
  readonly candidate: string;
  readonly quoteMinor: number;
  readonly quoteCurrency: string;
  readonly currency: string;
  readonly marginMinor: number;
  readonly marginPct: string;
  readonly minMarginPct: string;
  readonly minMarginZarMinor: number;
  readonly hourly: boolean;
}

export async function loadRepriceCard(
  db: Queryable,
  alert: RepriceAlert,
): Promise<RepriceCard | null> {
  const { rows } = await db.query<{
    job_title: string | null;
    hourly: boolean;
    display_name: string;
    quoted_price_minor: string;
    quote_currency: string;
    currency: string;
    margin_minor: string;
    margin_pct: string;
    min_margin_pct: string;
    min_margin_zar_minor: string;
  }>(
    `select j.title as job_title, j.hourly, c.display_name,
            c.quoted_price_minor::text as quoted_price_minor, c.currency::text as quote_currency,
            e.currency::text as currency, e.margin_minor::text as margin_minor,
            e.margin_pct::text as margin_pct, e.min_margin_pct::text as min_margin_pct,
            e.min_margin_zar_minor::text as min_margin_zar_minor
       from margin_evaluations e
       join jobs j on j.id = e.job_id
       join supplier_candidates c on c.id = $2
      where e.id = $1 and e.org_id = $3 and c.org_id = $3`,
    [alert.evaluationId, alert.candidateId, alert.orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    jobTitle: row.job_title,
    candidate: row.display_name,
    quoteMinor: Number(row.quoted_price_minor),
    quoteCurrency: row.quote_currency.trim(),
    currency: row.currency.trim(),
    marginMinor: Number(row.margin_minor),
    marginPct: row.margin_pct,
    minMarginPct: row.min_margin_pct,
    minMarginZarMinor: Number(row.min_margin_zar_minor),
    hourly: row.hourly,
  };
}

export function renderReprice(card: RepriceCard): string {
  const rule = card.hourly
    ? `at least ${formatPercent(Number(card.minMarginPct) / 100)}`
    : `at least ${formatPercent(Number(card.minMarginPct) / 100)} and ${formatMoney(card.minMarginZarMinor, 'ZAR')}`;
  return [
    'Margin below the rule after a supplier quote',
    `Job: ${card.jobTitle ?? 'no title'}`,
    `Quote: ${formatMoney(card.quoteMinor, card.quoteCurrency)} from ${card.candidate}`,
    `Margin: ${formatMoney(card.marginMinor, card.currency)} (${formatPercent(Number(card.marginPct) / 100)})`,
    `Rule: ${rule}`,
    '',
    'Nothing has been sent. Open the sourcing page to choose another candidate.',
  ].join('\n');
}

/** Sends the card to every linked chat that may act for the org; returns how many. */
export async function notifyReprice(deps: BotDeps, alert: RepriceAlert): Promise<number> {
  const card = await loadRepriceCard(deps.db, alert);
  if (!card) return 0;
  const { rows } = await deps.db.query<{ chat_id: string }>(
    `select u.telegram_chat_id as chat_id
       from memberships m
       join users u on u.id = m.user_id
      where m.org_id = $1 and m.role in ('owner', 'operator') and u.telegram_chat_id is not null`,
    [alert.orgId],
  );
  const text = renderReprice(card);
  for (const row of rows) await deps.api.sendMessage(row.chat_id, text);
  return rows.length;
}

/** The reprice worker's `alert` dependency, bound to this bot. */
export function repriceAlert(deps: BotDeps): (alert: RepriceAlert) => Promise<number> {
  return (alert) => notifyReprice(deps, alert);
}
