import { withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, type ServerOptions } from '../context.js';

/**
 * Market price bands (ARB-013, docs/01 section D): the p25/p50/p75 per category and
 * currency that ARB-040 prices from when the owner has no rate card. Reference data, so
 * any member may read it (0008); the page labels every `source='seed'` row as a seed
 * figure, not an observation.
 *
 * None is invented (docs/BLOCKERS.md D-14), so on a fresh database the list is empty and
 * the page says why. Amounts cross the wire as text, like every other sum (D-035).
 */
interface BandRow {
  readonly id: string;
  readonly category_slug: string;
  readonly category_name: string;
  readonly currency: string;
  readonly p25_minor: string;
  readonly p50_minor: string;
  readonly p75_minor: string;
  readonly sample_size: number;
  readonly source: string;
  readonly sampled_at: string;
}

export function registerPriceBandRoutes(app: FastifyInstance, options: ServerOptions): void {
  /** The seeded categories (docs/01 section D), for the brief's category field (ARB-140). */
  app.get('/v1/service-categories', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const { rows } = await tx.query<{ slug: string; name: string; in_house: boolean }>(
        'select slug, name, in_house from service_categories order by sort_order, name',
      );
      return rows;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send({
      categories: result.map((row) => ({ slug: row.slug, name: row.name, inHouse: row.in_house })),
    });
  });

  app.get('/v1/price-bands', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const categories = await tx.query<{ count: number }>(
        'select count(*)::int as count from service_categories',
      );
      const bands = await tx.query<BandRow>(
        `select b.id, b.category_slug, c.name as category_name, b.currency::text as currency,
                b.p25_minor::text, b.p50_minor::text, b.p75_minor::text, b.sample_size,
                b.source::text as source, b.sampled_at
         from market_price_bands b
         join service_categories c on c.slug = b.category_slug
         order by c.sort_order, c.name, b.currency, b.source`,
      );
      return { categories: categories.rows[0]?.count ?? 0, bands: bands.rows };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });

    return reply.send({
      categories: result.categories,
      bands: result.bands.map((band) => ({
        id: band.id,
        categorySlug: band.category_slug,
        categoryName: band.category_name,
        currency: band.currency.trim(),
        p25Minor: band.p25_minor,
        p50Minor: band.p50_minor,
        p75Minor: band.p75_minor,
        sampleSize: band.sample_size,
        source: band.source,
        sampledAt: band.sampled_at,
      })),
    });
  });
}
