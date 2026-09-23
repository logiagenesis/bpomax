import { canWrite } from '@arbitron/core';
import { recordEvent, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { channelOf, currentMembership, UUID, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * The feed (ARB-061, docs/01 section I): "jobs with score, estimate, margin, Queue bid
 * button". Each row is the job with the latest of each stored judgement beside it; the
 * page shows what is stored and nothing it worked out itself (05 section 3.3).
 */
export interface FeedRow {
  readonly id: string;
  readonly platform: string;
  readonly external_id: string;
  readonly title: string;
  readonly currency: string | null;
  readonly budget_min_minor: string | null;
  readonly budget_max_minor: string | null;
  readonly hourly: boolean;
  readonly client_country: string | null;
  readonly client_payment_verified: boolean | null;
  readonly bid_count: number | null;
  readonly posted_at: string | null;
  readonly first_seen_at: string;
  readonly category_slug: string | null;
  readonly score: number | null;
  readonly verdict: string | null;
  readonly flags: string[] | null;
  readonly estimate_expected_minor: string | null;
  readonly estimate_currency: string | null;
  readonly estimate_method: string | null;
  readonly margin_id: string | null;
  readonly margin_minor: string | null;
  readonly margin_pct: string | null;
  readonly margin_currency: string | null;
  readonly margin_passed: boolean | null;
  readonly margin_reason: string | null;
  readonly proposal_id: string | null;
  readonly proposal_status: string | null;
}

const VERDICTS = new Set(['go', 'caution', 'skip', 'unscored']);
export const FEED_PAGE_LIMIT = 25;
const FEED_MAX_LIMIT = 100;

const FEED_SQL = `
  select j.id, j.platform::text as platform, j.external_id, j.title, j.currency,
         j.budget_min_minor::text, j.budget_max_minor::text, j.hourly, j.client_country,
         j.client_payment_verified, j.bid_count, j.posted_at, j.first_seen_at, j.category_slug,
         s.score, s.verdict::text as verdict, s.flags,
         e.expected_minor::text as estimate_expected_minor, e.currency as estimate_currency,
         e.method::text as estimate_method,
         m.id as margin_id, m.margin_minor::text, m.margin_pct::text, m.currency as margin_currency,
         m.passed as margin_passed, m.reason as margin_reason,
         p.id as proposal_id, p.status::text as proposal_status
  from jobs j
  left join lateral (select score, verdict, flags from job_scores where job_id = j.id order by created_at desc limit 1) s on true
  left join lateral (select expected_minor, currency, method from delivery_estimates where job_id = j.id order by created_at desc limit 1) e on true
  left join lateral (select id, margin_minor, margin_pct, currency, passed, reason from margin_evaluations where job_id = j.id order by created_at desc limit 1) m on true
  left join lateral (select id, status from proposals where job_id = j.id order by created_at desc limit 1) p on true`;

export function registerJobRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/jobs', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const query = request.query as { verdict?: string; limit?: string; offset?: string };
    if (query.verdict !== undefined && !VERDICTS.has(query.verdict)) {
      return reply.code(400).send({ error: `unknown verdict: ${query.verdict}` });
    }
    const limit = query.limit === undefined ? FEED_PAGE_LIMIT : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) {
      return reply
        .code(400)
        .send({ error: `limit must be a whole number from 1 to ${String(FEED_MAX_LIMIT)}` });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return reply.code(400).send({ error: 'offset must be a whole number of zero or more' });
    }

    const where =
      query.verdict === undefined
        ? ''
        : query.verdict === 'unscored'
          ? 'where s.verdict is null'
          : `where s.verdict = $3`;
    const params: unknown[] = [limit, offset];
    if (where.includes('$3')) params.push(query.verdict);

    const jobs = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<FeedRow>(
        `${FEED_SQL} ${where} order by j.first_seen_at desc, j.id limit $1 offset $2`,
        params,
      );
      return rows;
    });
    return reply.send({ jobs, page: { limit, offset } });
  });

  /**
   * "Queue bid": ask for a bid on this job to be drafted and put up for approval.
   *
   * The drafting itself is the draft-bid worker's (ARB-043), which needs a passed margin
   * evaluation to price from. So: a job with a passed margin and no live proposal is
   * drafted; a job that has never been scored is scored, and the chain (score → estimate
   * → margin → draft, D-028 to D-031) carries it the rest of the way; anything else is
   * refused with the stored reason. Nothing here invents a price or bypasses approval.
   */
  app.post('/v1/jobs/:id/queue-bid', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role)) throw refuse(403, 'your role can view the feed but not queue bids');

        const { rows } = await tx.query<FeedRow>(`${FEED_SQL} where j.id = $1`, [id]);
        const job = rows[0];
        if (!job) throw refuse(404, 'no such job');

        if (
          job.proposal_status &&
          ['queued', 'approved', 'submitted'].includes(job.proposal_status)
        ) {
          const word =
            job.proposal_status === 'queued'
              ? 'is already waiting for approval'
              : job.proposal_status === 'approved'
                ? 'is already approved and on its way'
                : 'has already been sent';
          throw refuse(409, `A bid for this job ${word}.`);
        }

        let action: 'drafting' | 'scoring';
        if (job.margin_id && job.margin_passed) {
          if (!options.enqueue?.draft)
            throw refuse(503, 'The drafting queue is not available. Try again later.');
          action = 'drafting';
        } else if (job.verdict === null) {
          if (!options.enqueue?.score)
            throw refuse(503, 'The scoring queue is not available. Try again later.');
          action = 'scoring';
        } else if (job.verdict === 'skip') {
          throw refuse(422, 'This job was scored skip, so no bid is drafted for it.');
        } else if (job.margin_id) {
          throw refuse(
            422,
            `The margin did not pass: ${job.margin_reason ?? 'no reason stored'}. Change the rules in Settings, then try again.`,
          );
        } else {
          throw refuse(
            409,
            'The estimate and margin are still being worked out. Try again shortly.',
          );
        }

        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'proposal.draft_requested',
          actorUserId: me.userId,
          subjectTable: 'jobs',
          subjectId: job.id,
          requestId: request.id,
          payload: { action, via: channelOf(request), margin_evaluation_id: job.margin_id },
        });
        return { action, job, requestId: request.id };
      });

      // Enqueued after the event has committed, so a queue that is down leaves a record
      // and nothing runs that the log does not know about.
      if (result.action === 'drafting') {
        await options.enqueue!.draft!({
          jobId: result.job.id,
          ...(result.job.margin_id ? { marginEvaluationId: result.job.margin_id } : {}),
          requestId: result.requestId,
        });
      } else {
        await options.enqueue!.score!({ jobId: result.job.id, requestId: result.requestId });
      }
      return reply.code(202).send({ action: result.action, jobId: result.job.id });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /** One job with its latest stored judgements and its latest delivery estimate in full. */
  app.get('/v1/jobs/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const result = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<FeedRow>(`${FEED_SQL} where j.id = $1`, [id]);
      const job = rows[0];
      if (!job) return null;
      const estimate = await tx.query<{
        method: string;
        currency: string;
        low_minor: string;
        expected_minor: string;
        high_minor: string;
        turnaround_days: number | null;
        created_at: string;
      }>(
        `select method::text as method, currency::text as currency, low_minor::text as low_minor,
                expected_minor::text as expected_minor, high_minor::text as high_minor,
                turnaround_days, created_at
           from delivery_estimates where job_id = $1 order by created_at desc limit 1`,
        [id],
      );
      const e = estimate.rows[0];
      return {
        job,
        estimate: e
          ? {
              method: e.method,
              currency: e.currency.trim(),
              lowMinor: e.low_minor,
              expectedMinor: e.expected_minor,
              highMinor: e.high_minor,
              turnaroundDays: e.turnaround_days,
              createdAt: e.created_at,
            }
          : null,
      };
    });
    if (!result) return reply.code(404).send({ error: 'no such job' });
    return reply.send(result);
  });

  /**
   * Asks for a job to be scored now (ARB-330's score_job). The score worker judges it, and
   * the chain carries it on to the estimate and the margin (D-028 to D-031).
   */
  app.post('/v1/jobs/:id/score', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const jobId = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role)) throw refuse(403, 'your role can view the feed but not score jobs');
        const { rows } = await tx.query<{ id: string }>('select id from jobs where id = $1', [id]);
        if (!rows[0]) throw refuse(404, 'no such job');
        if (!options.enqueue?.score)
          throw refuse(503, 'The scoring queue is not available. Try again later.');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'job.score_requested',
          actorUserId: me.userId,
          subjectTable: 'jobs',
          subjectId: id,
          requestId: request.id,
          payload: { via: channelOf(request) },
        });
        return id;
      });
      await options.enqueue!.score!({ jobId, requestId: request.id });
      return reply.code(202).send({ action: 'scoring', jobId });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
