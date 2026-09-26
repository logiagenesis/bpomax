import { BAND_LOOKBACK_DAYS, MIN_BAND_SAMPLE, quartiles } from '@arbitron/core';
import type { Queryable } from './client.js';
import { recordEvent } from './events.js';

/**
 * The weekly price refresh (ARB-514, docs/01 section E, D-083): market bands worked from
 * completed projects. A sample is one delivery the house organisation accepted within
 * the look-back window, on a fixed-price job with a category, delivered by an outside
 * supplier at its agreed cost. In-house and AI-build deliveries are not the market's
 * price, hourly work is not a project price, and no other organisation's delivery is
 * read: the bands are shared by every organisation.
 *
 * A category and currency with enough samples gets a `completed_projects` band; one
 * that no longer has enough loses it, so a band never outlives its evidence. Seed, CSV
 * and marketplace bands are never touched.
 */
export interface BandRefresh {
  readonly categorySlug: string;
  readonly currency: string;
  readonly sampleSize: number;
  readonly p25Minor: string;
  readonly p50Minor: string;
  readonly p75Minor: string;
}

export interface PriceRefreshResult {
  readonly refreshed: readonly BandRefresh[];
  /** Groups with some samples but fewer than the minimum. */
  readonly tooFew: readonly { categorySlug: string; currency: string; sampleSize: number }[];
  /** Completed-project bands removed because their samples fell below the minimum. */
  readonly removed: number;
  readonly houseOrgs: number;
}

export async function refreshPriceBands(
  db: Queryable,
  options: { readonly now?: Date; readonly requestId?: string | null } = {},
): Promise<PriceRefreshResult> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - BAND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await db.query<{ category_slug: string; currency: string; cost: string }>(
    `select j.category_slug, d.currency::text as currency, d.agreed_cost_minor::text as cost
       from delivery_orders d
       join orgs o on o.id = d.org_id
       join pipeline_items pi on pi.id = d.pipeline_item_id
       join jobs j on j.id = pi.job_id
       left join suppliers s on s.id = d.supplier_id
      where o.billing_exempt
        and d.status = 'accepted'
        and d.accepted_at >= $1
        and d.agreed_cost_minor is not null
        and d.currency is not null
        and j.category_slug is not null
        and not j.hourly
        and (s.id is null or s.channel not in ('in_house', 'ai_build'))`,
    [since.toISOString()],
  );

  const groups = new Map<string, { categorySlug: string; currency: string; costs: bigint[] }>();
  for (const row of rows) {
    const key = `${row.category_slug} ${row.currency}`;
    const group = groups.get(key) ?? {
      categorySlug: row.category_slug,
      currency: row.currency,
      costs: [],
    };
    group.costs.push(BigInt(row.cost));
    groups.set(key, group);
  }

  const refreshed: BandRefresh[] = [];
  const tooFew: { categorySlug: string; currency: string; sampleSize: number }[] = [];
  for (const group of [...groups.values()].sort((a, b) =>
    `${a.categorySlug} ${a.currency}`.localeCompare(`${b.categorySlug} ${b.currency}`),
  )) {
    if (group.costs.length < MIN_BAND_SAMPLE) {
      tooFew.push({
        categorySlug: group.categorySlug,
        currency: group.currency,
        sampleSize: group.costs.length,
      });
      continue;
    }
    const q = quartiles(group.costs);
    await db.query(
      `insert into market_price_bands
         (category_slug, currency, p25_minor, p50_minor, p75_minor, sample_size, source, sampled_at)
       values ($1, $2, $3, $4, $5, $6, 'completed_projects', $7)
       on conflict (category_slug, currency, source) do update
         set p25_minor = excluded.p25_minor, p50_minor = excluded.p50_minor,
             p75_minor = excluded.p75_minor, sample_size = excluded.sample_size,
             sampled_at = excluded.sampled_at`,
      [
        group.categorySlug,
        group.currency,
        q.p25Minor.toString(),
        q.p50Minor.toString(),
        q.p75Minor.toString(),
        group.costs.length,
        now.toISOString(),
      ],
    );
    refreshed.push({
      categorySlug: group.categorySlug,
      currency: group.currency,
      sampleSize: group.costs.length,
      p25Minor: q.p25Minor.toString(),
      p50Minor: q.p50Minor.toString(),
      p75Minor: q.p75Minor.toString(),
    });
  }

  const removed = await db.query(
    `delete from market_price_bands b
      where b.source = 'completed_projects'
        and not exists (
          select 1 from unnest($1::text[], $2::text[]) as kept(category_slug, currency)
           where kept.category_slug = b.category_slug and kept.currency = b.currency
        )`,
    [refreshed.map((band) => band.categorySlug), refreshed.map((band) => band.currency)],
  );

  const house = await db.query<{ id: string }>(`select id from orgs where billing_exempt`);
  const result: PriceRefreshResult = {
    refreshed,
    tooFew,
    removed: removed.affectedRows ?? 0,
    houseOrgs: house.rows.length,
  };
  for (const org of house.rows) {
    await recordEvent(db, {
      orgId: org.id,
      type: 'price_bands.refreshed',
      requestId: options.requestId ?? null,
      outcome: refreshed.length > 0 || result.removed > 0 ? 'ok' : 'skipped',
      payload: {
        bands: refreshed.map((band) => ({
          category: band.categorySlug,
          currency: band.currency,
          sampleSize: band.sampleSize,
          p50Minor: band.p50Minor,
        })),
        tooFew,
        removed: result.removed,
        minSample: MIN_BAND_SAMPLE,
        lookbackDays: BAND_LOOKBACK_DAYS,
      },
    });
  }
  return result;
}
