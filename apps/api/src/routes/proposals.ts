import { canApprove, validateProposalEdit, validateRejection } from '@arbitron/core';
import {
  approveBid,
  editBid,
  recordEvent,
  rejectBid,
  withUser,
  type BidChange,
  type Queryable,
} from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  channelOf,
  currentMembership,
  invalid,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';
import { refuseOverLimit } from '../plan-limits.js';

/**
 * Approvals (ARB-061, docs/01 section I): "all pending outbound items, approve / edit /
 * reject, bulk". Today the outbound items are bids; messages and sourcing posts join
 * the list with their own tickets (ARB-122, ARB-203).
 *
 * The rules are the Telegram bot's (D-033), reached from the web instead: an approval
 * names the person who gave it and hands the bid to the submit worker, which holds the
 * live gate and the allowance (D-032); an edit puts the bid back in the queue with its
 * approval cleared; a rejection records its reason. A sent bid can be changed by none
 * of them. RLS decides who may write, and the restrictive policy in 0009 makes sure the
 * approver's name is the caller's own.
 */
export interface ProposalRow {
  readonly id: string;
  readonly job_id: string;
  readonly job_title: string;
  readonly platform: string;
  readonly status: string;
  readonly body: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly delivery_days: number;
  readonly milestones: unknown[];
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_via: string | null;
  readonly submitted_at: string | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly score: number | null;
  readonly verdict: string | null;
  readonly estimate_expected_minor: string | null;
  readonly estimate_currency: string | null;
  readonly estimate_method: string | null;
  readonly margin_minor: string | null;
  readonly margin_pct: string | null;
  readonly margin_currency: string | null;
  readonly fx_rate_used: string | null;
  readonly fx_rate_at: string | null;
}

const STATUSES = new Set(['queued', 'approved', 'rejected', 'submitted', 'failed', 'draft', 'all']);
export const BULK_LIMIT = 50;

const PROPOSAL_SQL = `
  select p.id, p.job_id, j.title as job_title, j.platform::text as platform, p.status::text as status,
         p.body, p.amount_minor::text, p.currency, p.delivery_days, p.milestones,
         p.approved_by, a.full_name as approved_by_name, p.approved_via::text as approved_via,
         p.submitted_at, p.failure_reason, p.created_at, p.updated_at,
         s.score, s.verdict::text as verdict,
         e.expected_minor::text as estimate_expected_minor, e.currency as estimate_currency,
         e.method::text as estimate_method,
         m.margin_minor::text, m.margin_pct::text, m.currency as margin_currency,
         m.fx_rate_used::text, m.fx_rate_at
  from proposals p
  join jobs j on j.id = p.job_id
  left join users a on a.id = p.approved_by
  left join lateral (select score, verdict from job_scores where job_id = p.job_id order by created_at desc limit 1) s on true
  left join margin_evaluations m on m.id = p.margin_evaluation_id
  left join delivery_estimates e on e.id = m.delivery_estimate_id`;

async function loadProposal(tx: Queryable, id: string): Promise<ProposalRow | null> {
  const { rows } = await tx.query<ProposalRow>(`${PROPOSAL_SQL} where p.id = $1`, [id]);
  return rows[0] ?? null;
}

async function approver(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canApprove(me.role)) throw refuse(403, 'your role can view bids but not change them');
  return me;
}

/**
 * The shared change (packages/db approvals.ts, ARB-512) with the API's own words for the
 * outcomes the page and its tests know: 404 "no such bid" and the per-action 403.
 */
function orRefuse(change: BidChange, action: 'approve' | 'reject' | 'edit'): void {
  if (change.ok) return;
  if (change.code === 404) throw refuse(404, 'no such bid');
  if (change.code === 403)
    throw refuse(403, `you do not have permission to ${action} bids in this org`);
  throw refuse(change.code, change.message);
}

async function approveOne(
  tx: Queryable,
  me: Membership,
  id: string,
  requestId: string,
  via: 'web' | 'mcp' = 'web',
): Promise<ProposalRow> {
  orRefuse(await approveBid(tx, me, id, via, { requestId }), 'approve');
  return (await loadProposal(tx, id))!;
}

async function rejectOne(
  tx: Queryable,
  me: Membership,
  id: string,
  reason: string,
  requestId: string,
  via: 'web' | 'mcp' = 'web',
): Promise<ProposalRow> {
  orRefuse(await rejectBid(tx, me, id, reason, via, { requestId }), 'reject');
  return (await loadProposal(tx, id))!;
}

async function isPaused(tx: Queryable): Promise<boolean> {
  const { rows } = await tx.query<{ bidding_paused: boolean }>(
    'select bidding_paused from settings limit 1',
  );
  return rows[0]?.bidding_paused ?? false;
}

export function registerProposalRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/proposals', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const query = request.query as { status?: string };
    const status = query.status ?? 'queued';
    if (!STATUSES.has(status)) return reply.code(400).send({ error: `unknown status: ${status}` });

    const result = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<ProposalRow>(
        `${PROPOSAL_SQL} ${status === 'all' ? '' : 'where p.status = $1'} order by p.created_at desc, p.id limit 200`,
        status === 'all' ? [] : [status],
      );
      return { proposals: rows, biddingPaused: await isPaused(tx) };
    });
    return reply.send(result);
  });

  app.post('/v1/proposals/:id/approve', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        const proposal = await approveOne(tx, me, id, request.id, channelOf(request));
        return { proposal, biddingPaused: await isPaused(tx) };
      });
      if (options.enqueue?.submit)
        await options.enqueue.submit({ proposalId: id, requestId: request.id });
      return reply.send({ ...result, queued: Boolean(options.enqueue?.submit) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /**
   * Hands an approved bid to the sender again (ARB-330's submit_bid): after a pause, a
   * failure the platform may not repeat, or a queue that was down at approval. The submit
   * worker still holds the live gate and the allowance (ARB-044); nothing is sent here, and
   * a bid that is not approved is refused.
   */
  app.post('/v1/proposals/:id/submit', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        const before = await loadProposal(tx, id);
        if (!before) throw refuse(404, 'no such bid');
        if (before.status === 'queued')
          throw refuse(409, 'This bid is waiting for approval. Approve it first.');
        if (before.status === 'submitted') throw refuse(409, 'This bid has already been sent.');
        if (before.status !== 'approved')
          throw refuse(409, `This bid is ${before.status}, so it is not sent.`);
        await refuseOverLimit(tx, me.orgId, 'bids_submitted');
        if (!options.enqueue?.submit)
          throw refuse(
            503,
            'The sender is not running here, so the bid cannot be handed to it now.',
          );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'proposal.submit_requested',
          actorUserId: me.userId,
          subjectTable: 'proposals',
          subjectId: id,
          requestId: request.id,
          payload: { via: channelOf(request) },
        });
      });
      await options.enqueue!.submit!({ proposalId: id, requestId: request.id });
      return reply.code(202).send({ queued: true });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/proposals/:id/reject', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const validated = validateRejection(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));

    try {
      const proposal = await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        return rejectOne(tx, me, id, validated.value.text, request.id, channelOf(request));
      });
      return reply.send({ proposal });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.patch('/v1/proposals/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const validated = validateProposalEdit(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const text = validated.value.text;

    try {
      const proposal = await withUser(options.db, authUserId, async (tx) => {
        const me = await approver(tx);
        // New words need a new approval: the old one covered the old words (D-033).
        orRefuse(
          await editBid(tx, me, id, text, channelOf(request), { requestId: request.id }),
          'edit',
        );
        return (await loadProposal(tx, id))!;
      });
      return reply.send({ proposal });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /**
   * Bulk approve or reject. Each bid is its own transaction and its own answer, so one
   * that has moved on since the page loaded does not stop the rest; the page shows the
   * outcome per row.
   */
  app.post('/v1/proposals/bulk', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const body = request.body as { action?: unknown; ids?: unknown; reason?: unknown } | null;
    const action = body?.action;
    if (action !== 'approve' && action !== 'reject') {
      return reply
        .code(422)
        .send(invalid([{ field: 'action', message: 'must be approve or reject' }]));
    }
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === 'string' && UUID.test(id))
    ) {
      return reply
        .code(422)
        .send(invalid([{ field: 'ids', message: 'must be a list of bid ids' }]));
    }
    if (ids.length > BULK_LIMIT) {
      return reply
        .code(422)
        .send(invalid([{ field: 'ids', message: `at most ${String(BULK_LIMIT)} at a time` }]));
    }
    let reason = '';
    if (action === 'reject') {
      const validated = validateRejection({ reason: body?.reason });
      if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
      reason = validated.value.text;
    }

    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids as string[]) {
      try {
        await withUser(options.db, authUserId, async (tx) => {
          const me = await approver(tx);
          if (action === 'approve') await approveOne(tx, me, id, request.id, channelOf(request));
          else await rejectOne(tx, me, id, reason, request.id, channelOf(request));
        });
        if (action === 'approve' && options.enqueue?.submit) {
          await options.enqueue.submit({ proposalId: id, requestId: request.id });
        }
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: messageOf(error) });
      }
    }
    return reply.send({ results });
  });
}
