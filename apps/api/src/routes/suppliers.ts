import {
  canWrite,
  supplierCsvTemplate,
  suppliersToCsv,
  validateSupplierCsv,
  type CsvLineError,
  type SupplierInput,
} from '@arbitron/core';
import { recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, type Membership, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * The supplier database (ARB-200, docs/01 section D and I: "suppliers (database, rate
 * cards, CSV import, history)"; docs/02 D-09: the owner supplies the list as a CSV).
 * The template is served here, the import checks every line and writes nothing unless
 * every line is right, and the export is the same columns so it imports again. Nothing
 * is seeded: every supplier and rate is the owner's (D-09).
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

interface SupplierRow {
  readonly id: string;
  readonly name: string;
  readonly country_code: string | null;
  readonly time_zone: string | null;
  readonly channel: string;
  readonly languages: string[];
  readonly quality_score: string | null;
  readonly on_time_rate: string | null;
  readonly pays_after_delivery: boolean;
  readonly external_profile_url: string | null;
  readonly notes: string | null;
  readonly active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RateCardRow {
  readonly id: string;
  readonly supplier_id: string;
  readonly category_slug: string;
  readonly category_name: string;
  readonly currency: string;
  readonly fixed_price_minor: string | null;
  readonly hourly_rate_minor: string | null;
  readonly turnaround_days: number | null;
}

async function loadSuppliers(tx: Queryable) {
  const suppliers = await tx.query<SupplierRow>(
    `select id, name, country_code, time_zone, channel::text as channel, languages,
            quality_score::text as quality_score, on_time_rate::text as on_time_rate,
            pays_after_delivery, external_profile_url, notes, active, created_at, updated_at
       from suppliers order by lower(name), id`,
  );
  const cards = await tx.query<RateCardRow>(
    `select r.id, r.supplier_id, r.category_slug, c.name as category_name, r.currency::text as currency,
            r.fixed_price_minor::text as fixed_price_minor, r.hourly_rate_minor::text as hourly_rate_minor,
            r.turnaround_days
       from supplier_rate_cards r
       join service_categories c on c.slug = r.category_slug
       order by c.sort_order, c.name, r.currency`,
  );
  return suppliers.rows.map((s) => ({
    id: s.id,
    name: s.name,
    countryCode: s.country_code,
    timeZone: s.time_zone,
    channel: s.channel,
    languages: s.languages,
    qualityScore: s.quality_score,
    onTimeRate: s.on_time_rate,
    paysAfterDelivery: s.pays_after_delivery,
    externalProfileUrl: s.external_profile_url,
    notes: s.notes,
    active: s.active,
    rateCards: cards.rows
      .filter((r) => r.supplier_id === s.id)
      .map((r) => ({
        id: r.id,
        categorySlug: r.category_slug,
        categoryName: r.category_name,
        currency: r.currency.trim(),
        fixedPriceMinor: r.fixed_price_minor,
        hourlyRateMinor: r.hourly_rate_minor,
        turnaroundDays: r.turnaround_days,
      })),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

async function categorySlugs(tx: Queryable): Promise<Set<string>> {
  const { rows } = await tx.query<{ slug: string }>('select slug from service_categories');
  return new Set(rows.map((r) => r.slug));
}

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view suppliers but not import them');
  return me;
}

/** Writes the checked suppliers: a supplier by (org, name), a rate card by (supplier, category, currency). */
async function writeSuppliers(
  tx: Queryable,
  orgId: string,
  suppliers: readonly SupplierInput[],
): Promise<{ created: number; updated: number; rateCards: number }> {
  let created = 0;
  let updated = 0;
  let rateCards = 0;
  for (const s of suppliers) {
    const { rows } = await tx.query<{ id: string; inserted: boolean }>(
      `insert into suppliers (org_id, name, country_code, time_zone, channel, languages, quality_score,
                              on_time_rate, pays_after_delivery, external_profile_url, notes, active)
       values ($1, $2, $3, $4, $5::supplier_channel, $6, $7, $8, $9, $10, $11, $12)
       on conflict (org_id, name) do update set
         country_code = excluded.country_code, time_zone = excluded.time_zone, channel = excluded.channel,
         languages = excluded.languages, quality_score = excluded.quality_score, on_time_rate = excluded.on_time_rate,
         pays_after_delivery = excluded.pays_after_delivery, external_profile_url = excluded.external_profile_url,
         notes = excluded.notes, active = excluded.active
       returning id, (xmax = 0) as inserted`,
      [
        orgId,
        s.name,
        s.countryCode,
        s.timeZone,
        s.channel,
        s.languages,
        s.qualityScore,
        s.onTimeRate,
        s.paysAfterDelivery,
        s.externalProfileUrl,
        s.notes,
        s.active,
      ],
    );
    const row = rows[0];
    if (!row) throw refuse(403, 'you do not have permission to change suppliers in this org');
    if (row.inserted) created += 1;
    else updated += 1;
    for (const card of s.rateCards) {
      await tx.query(
        `insert into supplier_rate_cards (org_id, supplier_id, category_slug, currency, fixed_price_minor, hourly_rate_minor, turnaround_days)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (supplier_id, category_slug, currency) do update set
           fixed_price_minor = excluded.fixed_price_minor, hourly_rate_minor = excluded.hourly_rate_minor,
           turnaround_days = excluded.turnaround_days`,
        [
          orgId,
          row.id,
          card.categorySlug,
          card.currency,
          card.fixedPriceMinor,
          card.hourlyRateMinor,
          card.turnaroundDays,
        ],
      );
      rateCards += 1;
    }
  }
  return { created, updated, rateCards };
}

export function registerSupplierRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/suppliers', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      return me ? loadSuppliers(tx) : null;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send({ suppliers: result });
  });

  /** The template: the heading and one sample line the import refuses (docs/02 D-09). */
  app.get('/v1/suppliers/template.csv', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="suppliers-template.csv"')
      .send(supplierCsvTemplate());
  });

  /** The database as the same columns, so a file exported here imports again unchanged. */
  app.get('/v1/suppliers.csv', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      return me ? loadSuppliers(tx) : null;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    const now = options.now ? options.now() : new Date();
    const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="suppliers-${stamp}.csv"`)
      .header('x-export-rows', String(result.length))
      .header('x-export-truncated', 'false')
      .send(suppliersToCsv(result));
  });

  /**
   * The import. Every line is checked first; one problem anywhere and nothing is
   * written, with every problem returned by line. `dryRun` checks without writing.
   */
  app.post('/v1/suppliers/import', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const body = request.body as { csv?: unknown; dryRun?: unknown } | null;
    const csv = body?.csv;
    if (typeof csv !== 'string') {
      return reply.code(422).send({
        error: 'the request was not accepted',
        errors: [{ field: 'csv', message: 'must be the file as text' }],
      });
    }
    if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) {
      return reply.code(422).send({
        error: 'the request was not accepted',
        errors: [{ field: 'csv', message: 'must be 2 MB or smaller' }],
      });
    }
    const dryRun = body?.dryRun === true;
    try {
      const outcome = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const checked = validateSupplierCsv(csv, { categories: await categorySlugs(tx) });
        if (!checked.ok) return { ok: false as const, errors: checked.errors };
        const rateCards = checked.value.reduce((n, s) => n + s.rateCards.length, 0);
        if (dryRun) {
          return {
            ok: true as const,
            dryRun: true,
            lines: checked.lines,
            suppliers: checked.value.length,
            rateCards,
            created: 0,
            updated: 0,
          };
        }
        const written = await writeSuppliers(tx, me.orgId, checked.value);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'supplier.imported',
          actorUserId: me.userId,
          subjectTable: 'suppliers',
          requestId: request.id,
          payload: {
            via: 'web',
            lines: checked.lines,
            suppliers: checked.value.length,
            rate_cards: written.rateCards,
            created: written.created,
            updated: written.updated,
          },
        });
        return {
          ok: true as const,
          dryRun: false,
          lines: checked.lines,
          suppliers: checked.value.length,
          ...written,
        };
      });
      if (!outcome.ok) {
        const lines = new Set(outcome.errors.map((e: CsvLineError) => e.line)).size;
        return reply.code(422).send({
          error: `${String(lines)} line${lines === 1 ? ' has' : 's have'} problems; nothing was imported.`,
          errors: outcome.errors,
        });
      }
      return reply.send(outcome);
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
