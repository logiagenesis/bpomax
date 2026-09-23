import {
  ANALYTICS_DIMENSIONS,
  aggregateAnalytics,
  analyticsTotal,
  type AnalyticsDimension,
  type JobFacts,
} from '@arbitron/core';
import { withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Analytics (ARB-320, docs/01 section A step 9 and section I): reply rate, win rate, cost
 * per reply and realised margin by category, template, supplier or scanner. The rows are
 * `analytics_job_facts` (0028), one per job with a submitted bid, read with the caller's
 * rights; they are grouped by `aggregateAnalytics` in core, where each formula is written
 * and hand-worked. Money is minor-unit text; model spend is nano-US-dollars (D-021).
 */
interface FactsRow {
  readonly job_id: string;
  readonly category_slug: string | null;
  readonly category_name: string | null;
  readonly template_id: string | null;
  readonly template_name: string | null;
  readonly supplier_key: string | null;
  readonly supplier_name: string | null;
  readonly scanner_id: string | null;
  readonly scanner_name: string | null;
  readonly replied: boolean;
  readonly won: boolean;
  readonly lost: boolean;
  readonly in_zar_minor: string;
  readonly out_zar_minor: string;
  readonly unconverted_payments: number;
  readonly model_cost_nano_usd: string;
}

export async function readJobFacts(tx: Queryable, since: string | null): Promise<JobFacts[]> {
  const { rows } = await tx.query<FactsRow>(
    `select job_id, category_slug, category_name, template_id, template_name, supplier_key,
            supplier_name, scanner_id, scanner_name, replied, won, lost,
            in_zar_minor::text as in_zar_minor, out_zar_minor::text as out_zar_minor,
            unconverted_payments, model_cost_nano_usd::text as model_cost_nano_usd
       from analytics_job_facts
      where ($1::timestamptz is null or submitted_at >= $1::timestamptz)`,
    [since],
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    categoryKey: r.category_slug,
    categoryLabel: r.category_name,
    templateKey: r.template_id,
    templateLabel: r.template_name,
    supplierKey: r.supplier_key,
    supplierLabel: r.supplier_name,
    scannerKey: r.scanner_id,
    scannerLabel: r.scanner_name,
    replied: r.replied,
    won: r.won,
    lost: r.lost,
    inZarMinor: r.in_zar_minor,
    outZarMinor: r.out_zar_minor,
    unconvertedPayments: Number(r.unconverted_payments),
    modelCostNanoUsd: r.model_cost_nano_usd,
  }));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAnalyticsRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/analytics', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const query = request.query as { by?: string; since?: string };
    const by = (query.by ?? 'category') as AnalyticsDimension;
    if (!ANALYTICS_DIMENSIONS.includes(by))
      return reply
        .code(422)
        .send(
          invalid([{ field: 'by', message: `must be one of ${ANALYTICS_DIMENSIONS.join(', ')}` }]),
        );
    const sinceDay = query.since ?? null;
    if (sinceDay !== null && !ISO_DATE.test(sinceDay))
      return reply
        .code(422)
        .send(invalid([{ field: 'since', message: 'must be a date as YYYY-MM-DD' }]));
    // A day starts at 00:00 SAST (UTC+2).
    const since = sinceDay === null ? null : `${sinceDay}T00:00:00+02:00`;
    try {
      const facts = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        return readJobFacts(tx, since);
      });
      return reply.send({
        by,
        since: sinceDay,
        total: analyticsTotal(facts),
        rows: aggregateAnalytics(facts, by),
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
