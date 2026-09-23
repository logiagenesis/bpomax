import {
  canWrite,
  rankSuppliers,
  type RankableSupplier,
  type SupplierChannel,
} from '@arbitron/core';
import { briefInputOf, loadBrief, recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  currentMembership,
  invalid,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Sourcing requests (ARB-201, docs/01 section E: the sourcing worker "ranks existing
 * suppliers"; section I: the sourcing page's requests, candidates and shortlist). A
 * request starts from a locked brief that is not delivered in-house (D-04), ranks every
 * supplier with a rate card in the brief's category (`rankSuppliers`, deterministic and
 * explained), and stores one candidate per ranked supplier with its score, parts and
 * reasons, and the suppliers left out with the reason. Posting to a marketplace is
 * ARB-202 and ARB-203; nothing here leaves the database.
 */
interface RequestRow {
  readonly id: string;
  readonly brief_id: string;
  readonly brief_version: number;
  readonly brief_title: string;
  readonly category_slug: string | null;
  readonly delivery_route: string | null;
  readonly thread_id: string;
  readonly client_handle: string | null;
  readonly job_title: string | null;
  readonly channels: string[];
  readonly status: string;
  readonly excluded: { supplierId: string; name: string; reason: string }[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly candidate_count: number;
  readonly shortlisted_count: number;
}

interface CandidateRow {
  readonly id: string;
  readonly supplier_id: string | null;
  readonly display_name: string;
  readonly country_code: string | null;
  readonly quoted_price_minor: string | null;
  readonly currency: string | null;
  readonly turnaround_days: number | null;
  readonly score: string | null;
  readonly shortlisted: boolean;
  readonly ranking: Record<string, unknown>;
  readonly supplier_channel: string | null;
  readonly supplier_time_zone: string | null;
  readonly external_bid_id: string | null;
  readonly sourcing_post_id: string | null;
  readonly margin_evaluation_id: string | null;
  readonly margin_minor: string | null;
  readonly margin_pct: string | null;
  readonly margin_currency: string | null;
  readonly margin_passed: boolean | null;
  readonly margin_reason: string | null;
  readonly margin_at: string | null;
  readonly reprice_outcome: string | null;
  readonly reprice_payload: Record<string, unknown> | null;
  readonly reprice_at: string | null;
}

const REQUEST_SQL = `
  select r.id, r.brief_id, b.version as brief_version, b.title as brief_title, b.category_slug,
         b.delivery_route::text as delivery_route, b.thread_id, t.client_handle, j.title as job_title,
         r.channels::text[] as channels, r.status::text as status, r.excluded, r.created_at, r.updated_at,
         (select count(*)::int from supplier_candidates c where c.sourcing_request_id = r.id) as candidate_count,
         (select count(*)::int from supplier_candidates c where c.sourcing_request_id = r.id and c.shortlisted) as shortlisted_count
    from sourcing_requests r
    join briefs b on b.id = r.brief_id
    join threads t on t.id = b.thread_id
    left join jobs j on j.id = t.job_id`;

const CANDIDATES_SQL = `
  select c.id, c.supplier_id, c.display_name, c.country_code, c.quoted_price_minor::text as quoted_price_minor,
         c.currency::text as currency, c.turnaround_days, c.score::text as score, c.shortlisted, c.ranking,
         s.channel::text as supplier_channel, s.time_zone as supplier_time_zone,
         c.external_bid_id, c.sourcing_post_id,
         m.id as margin_evaluation_id, m.margin_minor::text as margin_minor, m.margin_pct::text as margin_pct,
         m.currency::text as margin_currency, m.passed as margin_passed, m.reason as margin_reason,
         m.created_at as margin_at,
         ev.outcome::text as reprice_outcome, ev.payload as reprice_payload, ev.created_at as reprice_at
    from supplier_candidates c
    left join suppliers s on s.id = c.supplier_id
    -- ARB-204: the margin the candidate's latest priced quote gives, and the last reprice's outcome.
    left join lateral (
      select e.id, e.margin_minor, e.margin_pct, e.currency, e.passed, e.reason, e.created_at
        from delivery_estimates d join margin_evaluations e on e.delivery_estimate_id = d.id
       where d.supplier_candidate_id = c.id
       order by e.created_at desc limit 1
    ) m on true
    left join lateral (
      select v.outcome, v.payload, v.created_at from events v
       where v.type = 'margin.repriced' and v.subject_table = 'supplier_candidates' and v.subject_id = c.id
       order by v.created_at desc limit 1
    ) ev on true
   where c.sourcing_request_id = $1
   order by c.score desc nulls last, c.display_name, c.id`;

function describeCandidate(row: CandidateRow) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    name: row.display_name,
    channel: row.supplier_channel,
    countryCode: row.country_code,
    timeZone: row.supplier_time_zone,
    currency: row.currency?.trim() ?? null,
    quotedPriceMinor: row.quoted_price_minor,
    priced: (row.ranking.priced as string | undefined) ?? 'fixed',
    turnaroundDays: row.turnaround_days,
    score: row.score === null ? null : Number(row.score),
    parts: (row.ranking.parts as Record<string, number> | undefined) ?? null,
    reasons: (row.ranking.reasons as string[] | undefined) ?? [],
    shortlisted: row.shortlisted,
    /** Ranked from the supplier database (ARB-201), or a bid on a posted project (ARB-203). */
    source: row.external_bid_id ? ('bid' as const) : ('ranking' as const),
    externalBidId: row.external_bid_id,
    sourcingPostId: row.sourcing_post_id,
    /** ARB-204: the margin with this candidate's quote as the supplier cost, once priced. */
    margin:
      row.margin_evaluation_id === null
        ? null
        : {
            evaluationId: row.margin_evaluation_id,
            currency: row.margin_currency?.trim() ?? null,
            marginMinor: row.margin_minor,
            marginPct: row.margin_pct,
            passed: row.margin_passed,
            reason: row.margin_reason,
            at: row.margin_at,
          },
    /** The last reprice's outcome: 'ok', or 'blocked' or 'skipped' with the reason. */
    reprice:
      row.reprice_outcome === null
        ? null
        : {
            outcome: row.reprice_outcome,
            reason: (row.reprice_payload?.reason as string | undefined) ?? null,
            message: (row.reprice_payload?.message as string | undefined) ?? null,
            detail: (row.reprice_payload?.detail as string[] | undefined) ?? [],
            at: row.reprice_at,
          },
  };
}

function describeRequest(row: RequestRow, candidates?: readonly CandidateRow[]) {
  return {
    id: row.id,
    briefId: row.brief_id,
    briefVersion: row.brief_version,
    briefTitle: row.brief_title,
    category: row.category_slug,
    deliveryRoute: row.delivery_route,
    threadId: row.thread_id,
    clientHandle: row.client_handle,
    jobTitle: row.job_title,
    channels: row.channels,
    status: row.status,
    candidateCount: row.candidate_count,
    shortlistedCount: row.shortlisted_count,
    excluded: row.excluded,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(candidates ? { candidates: candidates.map(describeCandidate) } : {}),
  };
}

async function loadRequest(tx: Queryable, id: string): Promise<RequestRow> {
  const { rows } = await tx.query<RequestRow>(`${REQUEST_SQL} where r.id = $1`, [id]);
  if (!rows[0]) throw refuse(404, 'no such sourcing request');
  return rows[0];
}

async function loadCandidates(tx: Queryable, requestId: string): Promise<CandidateRow[]> {
  const { rows } = await tx.query<CandidateRow>(CANDIDATES_SQL, [requestId]);
  return rows;
}

/** Every supplier of the org with its rate cards in the category; RLS scopes the org. */
async function rankableSuppliers(tx: Queryable, category: string): Promise<RankableSupplier[]> {
  const { rows } = await tx.query<{
    id: string;
    name: string;
    country_code: string | null;
    time_zone: string | null;
    channel: string;
    quality_score: string | null;
    on_time_rate: string | null;
    pays_after_delivery: boolean;
    active: boolean;
    currency: string | null;
    fixed_price_minor: string | null;
    hourly_rate_minor: string | null;
    turnaround_days: number | null;
  }>(
    `select s.id, s.name, s.country_code, s.time_zone, s.channel::text as channel,
            s.quality_score::text as quality_score, s.on_time_rate::text as on_time_rate,
            s.pays_after_delivery, s.active, r.currency::text as currency,
            r.fixed_price_minor::text as fixed_price_minor, r.hourly_rate_minor::text as hourly_rate_minor,
            r.turnaround_days
       from suppliers s
       left join supplier_rate_cards r on r.supplier_id = s.id and r.category_slug = $1
      order by s.name, s.id, r.currency`,
    [category],
  );
  const byId = new Map<
    string,
    RankableSupplier & { rateCards: RankableSupplier['rateCards'][number][] }
  >();
  for (const row of rows) {
    let s = byId.get(row.id);
    if (!s) {
      s = {
        id: row.id,
        name: row.name,
        countryCode: row.country_code,
        timeZone: row.time_zone,
        channel: row.channel as SupplierChannel,
        qualityScore: row.quality_score,
        onTimeRate: row.on_time_rate,
        paysAfterDelivery: row.pays_after_delivery,
        active: row.active,
        rateCards: [],
      };
      byId.set(row.id, s);
    }
    if (row.currency !== null) {
      s.rateCards.push({
        currency: row.currency.trim(),
        fixedPriceMinor: row.fixed_price_minor,
        hourlyRateMinor: row.hourly_rate_minor,
        turnaroundDays: row.turnaround_days,
      });
    }
  }
  return [...byId.values()];
}

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view sourcing but not change it');
  return me;
}

export function registerSourcingRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.post('/v1/briefs/:id/sourcing', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const brief = await loadBrief(tx, id);
        if (!brief) throw refuse(404, 'no such brief');
        if (!brief.locked) throw refuse(409, 'The brief must be locked before sourcing starts.');
        const input = briefInputOf(brief);
        if (input.deliveryRoute === 'in_house') {
          throw refuse(
            422,
            'This brief is delivered in-house, so nothing is sourced (docs/02 D-04).',
          );
        }
        if (input.category === null) throw refuse(422, 'The brief has no service category.');
        const open = await tx.query<{ id: string }>(
          `select id from sourcing_requests where brief_id = $1 and status in ('open', 'shortlisting', 'chosen')`,
          [id],
        );
        if (open.rows[0]) throw refuse(409, 'Sourcing has already started for this brief.');
        const ranking = rankSuppliers(
          {
            category: input.category,
            budget: input.budget,
            deadline: input.deadline,
            deadlineFixed: input.deadlineFixed,
          },
          await rankableSuppliers(tx, input.category),
          { now },
        );
        const channels = [...new Set(ranking.ranked.map((r) => r.channel))];
        const inserted = await tx.query<{ id: string }>(
          `insert into sourcing_requests (org_id, brief_id, channels, excluded)
           values ($1, $2, $3::supplier_channel[], $4) returning id`,
          // An array literal: the driver does not serialise a JS array into an enum array.
          [me.orgId, id, `{${channels.join(',')}}`, JSON.stringify(ranking.excluded)],
        );
        const requestId = inserted.rows[0]?.id;
        if (!requestId)
          throw refuse(403, 'you do not have permission to start sourcing in this org');
        for (const r of ranking.ranked) {
          const candidate = await tx.query<{ id: string }>(
            `insert into supplier_candidates (org_id, sourcing_request_id, supplier_id, display_name, country_code,
                                              quoted_price_minor, currency, turnaround_days, score, ranking)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
            [
              me.orgId,
              requestId,
              r.supplierId,
              r.name,
              r.countryCode,
              r.quotedPriceMinor,
              r.currency,
              r.turnaroundDays,
              r.score,
              JSON.stringify({ priced: r.priced, parts: r.parts, reasons: r.reasons }),
            ],
          );
          await recordEvent(tx, {
            orgId: me.orgId,
            type: 'supplier.candidate_added',
            actorUserId: me.userId,
            subjectTable: 'supplier_candidates',
            subjectId: candidate.rows[0]?.id ?? null,
            requestId: request.id,
            payload: {
              via: 'ranking',
              sourcing_request_id: requestId,
              supplier_id: r.supplierId,
              score: r.score,
            },
          });
        }
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.requested',
          actorUserId: me.userId,
          subjectTable: 'sourcing_requests',
          subjectId: requestId,
          requestId: request.id,
          payload: {
            via: 'web',
            brief_id: id,
            category: input.category,
            ranked: ranking.ranked.length,
            excluded: ranking.excluded.length,
          },
        });
        return {
          row: await loadRequest(tx, requestId),
          candidates: await loadCandidates(tx, requestId),
        };
      });
      return reply.code(201).send({ request: describeRequest(result.row, result.candidates) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.get('/v1/briefs/:id/sourcing', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!(await loadBrief(tx, id))) throw refuse(404, 'no such brief');
        const { rows } = await tx.query<RequestRow>(
          `${REQUEST_SQL} where r.brief_id = $1 order by r.created_at desc limit 1`,
          [id],
        );
        const row = rows[0];
        return row ? { row, candidates: await loadCandidates(tx, row.id) } : null;
      });
      return reply.send({
        request: result ? describeRequest(result.row, result.candidates) : null,
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.get('/v1/sourcing-requests', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const { rows } = await tx.query<RequestRow>(
        `${REQUEST_SQL} order by r.created_at desc, r.id limit 100`,
      );
      return rows;
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });
    return reply.send({ requests: result.map((row) => describeRequest(row)) });
  });

  app.get('/v1/sourcing-requests/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const row = await loadRequest(tx, id);
        return { row, candidates: await loadCandidates(tx, id) };
      });
      return reply.send({ request: describeRequest(result.row, result.candidates) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /** Shortlist or unshortlist one candidate; the request is 'shortlisting' while any is shortlisted. */
  app.patch('/v1/sourcing-requests/:id/candidates/:candidateId', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id, candidateId } = request.params as { id: string; candidateId: string };
    if (!UUID.test(id) || !UUID.test(candidateId))
      return reply.code(400).send({ error: 'id is not a uuid' });
    const shortlisted = (request.body as { shortlisted?: unknown } | null)?.shortlisted;
    if (typeof shortlisted !== 'boolean')
      return reply
        .code(422)
        .send(invalid([{ field: 'shortlisted', message: 'must be true or false' }]));
    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const row = await loadRequest(tx, id);
        if (!['open', 'shortlisting'].includes(row.status))
          throw refuse(409, `This request is ${row.status}, so its shortlist cannot change.`);
        const updated = await tx.query<{ id: string }>(
          `update supplier_candidates set shortlisted = $3 where id = $2 and sourcing_request_id = $1 returning id`,
          [id, candidateId, shortlisted],
        );
        if (!updated.rows[0]) throw refuse(404, 'no such candidate on this request');
        const any = await tx.query<{ n: number }>(
          `select count(*)::int as n from supplier_candidates where sourcing_request_id = $1 and shortlisted`,
          [id],
        );
        await tx.query(`update sourcing_requests set status = $2::sourcing_status where id = $1`, [
          id,
          (any.rows[0]?.n ?? 0) > 0 ? 'shortlisting' : 'open',
        ]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'sourcing.shortlisted',
          actorUserId: me.userId,
          subjectTable: 'supplier_candidates',
          subjectId: candidateId,
          requestId: request.id,
          payload: { via: 'web', sourcing_request_id: id, shortlisted },
        });
        return { row: await loadRequest(tx, id), candidates: await loadCandidates(tx, id) };
      });
      return reply.send({ request: describeRequest(result.row, result.candidates) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /**
   * ARB-204: price the bid again with this candidate's quote as the supplier cost. The
   * reprice worker does the work, with the margin engine's rules (D-029); this only asks.
   */
  app.post('/v1/sourcing-requests/:id/candidates/:candidateId/reprice', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id, candidateId } = request.params as { id: string; candidateId: string };
    if (!UUID.test(id) || !UUID.test(candidateId))
      return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const candidate = await withUser(options.db, authUserId, async (tx) => {
        await writer(tx);
        const { rows } = await tx.query<{
          quoted_price_minor: string | null;
          job_id: string | null;
        }>(
          `select c.quoted_price_minor::text as quoted_price_minor, t.job_id
               from supplier_candidates c
               join sourcing_requests r on r.id = c.sourcing_request_id
               join briefs b on b.id = r.brief_id
               join threads t on t.id = b.thread_id
              where c.id = $2 and c.sourcing_request_id = $1`,
          [id, candidateId],
        );
        const row = rows[0];
        if (!row) throw refuse(404, 'no such candidate on this request');
        return row;
      });
      if (candidate.quoted_price_minor === null)
        return reply
          .code(409)
          .send({ error: 'This candidate has no quote yet, so there is nothing to reprice with.' });
      if (candidate.job_id === null)
        return reply.code(409).send({
          error:
            'The conversation behind this brief has no job, so there is no bid margin to reprice.',
        });
      if (!options.enqueue?.reprice)
        return reply.code(503).send({
          error:
            'The workers are not running here, so the quote cannot be priced now (docs/02 B-12).',
        });
      await options.enqueue.reprice({
        candidateId,
        quoteMinor: candidate.quoted_price_minor,
        requestId: request.id,
      });
      return reply.code(202).send({ queued: true });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
