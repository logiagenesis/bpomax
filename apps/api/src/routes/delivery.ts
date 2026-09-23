import {
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  MILESTONE_STATUSES,
  PIPELINE_STAGES,
  canWrite,
  handoverChecklist,
  milestoneTotal,
  pipelineStageFor,
  reconcileMilestones,
  transitionBlockers,
  validateDeliveryOrderEdit,
  type DeliveryMilestone,
  type DeliveryStatus,
  type HandoverItem,
  type MilestoneStatus,
} from '@arbitron/core';
import { briefInputOf, loadBrief, recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  currentMembership,
  invalid,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * The pipeline and delivery orders (ARB-310, docs/01 section A step 8 and section I's
 * pipeline page). A delivery order starts when a supplier is chosen on a sourcing request
 * (section I: "choose supplier"): the candidate's quote is the agreed cost, one milestone
 * holds all of it until the operator splits it, and the handover checklist is read from
 * the locked brief. The order moves draft → assigned → in progress → delivered →
 * accepted, each move checked by `transitionBlockers`; the milestones reconcile to the
 * agreed cost before a supplier is assigned, in core and in 0026's constraint. Paying the
 * supplier is ARB-311 (and T-05); nothing here moves money.
 */
interface OrderRow {
  readonly id: string;
  readonly pipeline_item_id: string;
  readonly status: DeliveryStatus;
  readonly agreed_cost_minor: string | null;
  readonly currency: string | null;
  readonly milestones: DeliveryMilestone[];
  readonly handover: HandoverItem[];
  readonly due: string | null;
  readonly handed_over_at: string | null;
  readonly delivered_at: string | null;
  readonly accepted_at: string | null;
  readonly cancelled_at: string | null;
  readonly supplier_id: string | null;
  readonly supplier_candidate_id: string | null;
  readonly sourcing_request_id: string | null;
  readonly supplier_name: string | null;
  readonly pipeline_stage: string;
  readonly job_title: string;
  readonly brief_title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const ORDER_SQL = `
  select o.id, o.pipeline_item_id, o.status::text as status, o.agreed_cost_minor::text as agreed_cost_minor,
         o.currency::text as currency, o.milestones, o.handover,
         (o.due_at at time zone 'Africa/Johannesburg')::date::text as due,
         o.handed_over_at, o.delivered_at, o.accepted_at, o.cancelled_at,
         o.supplier_id, o.supplier_candidate_id, o.sourcing_request_id,
         coalesce(s.name, c.display_name) as supplier_name,
         p.stage::text as pipeline_stage, j.title as job_title, b.title as brief_title,
         o.created_at, o.updated_at
    from delivery_orders o
    join pipeline_items p on p.id = o.pipeline_item_id
    join jobs j on j.id = p.job_id
    left join suppliers s on s.id = o.supplier_id
    left join supplier_candidates c on c.id = o.supplier_candidate_id
    left join briefs b on b.id = o.brief_id`;

function stateOf(row: OrderRow) {
  return {
    status: row.status,
    supplierChosen: row.supplier_id !== null || row.supplier_candidate_id !== null,
    agreedCostMinor: row.agreed_cost_minor === null ? null : Number(row.agreed_cost_minor),
    currency: row.currency?.trim() ?? null,
    milestones: row.milestones,
    handover: row.handover,
    pipelineStage: row.pipeline_stage,
  };
}

function describeOrder(row: OrderRow) {
  const state = stateOf(row);
  const reconciled =
    state.agreedCostMinor !== null && state.currency !== null && row.milestones.length > 0
      ? reconcileMilestones(row.milestones, state.agreedCostMinor, state.currency).ok
      : false;
  return {
    id: row.id,
    pipelineItemId: row.pipeline_item_id,
    status: row.status,
    jobTitle: row.job_title,
    briefTitle: row.brief_title,
    pipelineStage: row.pipeline_stage,
    supplierName: row.supplier_name,
    supplierId: row.supplier_id,
    supplierCandidateId: row.supplier_candidate_id,
    sourcingRequestId: row.sourcing_request_id,
    agreedCostMinor: row.agreed_cost_minor,
    currency: state.currency,
    due: row.due,
    milestones: row.milestones,
    milestonesTotalMinor: milestoneTotal(row.milestones).toString(),
    reconciled,
    handover: row.handover,
    handedOverAt: row.handed_over_at,
    deliveredAt: row.delivered_at,
    acceptedAt: row.accepted_at,
    cancelledAt: row.cancelled_at,
    /** For each move open from here, why it is not allowed yet (empty when it is). */
    moves: Object.fromEntries(
      DELIVERY_TRANSITIONS[row.status].map((to) => [to, transitionBlockers(state, to)]),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadOrder(tx: Queryable, id: string): Promise<OrderRow> {
  const { rows } = await tx.query<OrderRow>(`${ORDER_SQL} where o.id = $1`, [id]);
  if (!rows[0]) throw refuse(404, 'no such delivery order');
  return rows[0];
}

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view delivery but not change it');
  return me;
}

async function reader(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  return me;
}

function send(reply: FastifyReply, error: unknown) {
  const errors = (error as { errors?: unknown }).errors;
  return reply
    .code(statusOf(error))
    .send(errors ? { error: messageOf(error), errors } : { error: messageOf(error) });
}

/** Moves the job's pipeline stage and says so in the audit log. */
export async function moveStage(
  tx: Queryable,
  me: Membership,
  itemId: string,
  to: string,
  requestId: string,
  via: string,
): Promise<void> {
  const before = await tx.query<{ stage: string }>(
    'select stage::text as stage from pipeline_items where id = $1',
    [itemId],
  );
  const from = before.rows[0]?.stage;
  if (!from || from === to) return;
  await tx.query(
    `update pipeline_items set stage = $2::pipeline_stage, stage_changed_at = now() where id = $1`,
    [itemId, to],
  );
  await recordEvent(tx, {
    orgId: me.orgId,
    type: 'pipeline.stage_changed',
    actorUserId: me.userId,
    subjectTable: 'pipeline_items',
    subjectId: itemId,
    requestId,
    payload: { via, from, to },
  });
}

interface PipelineRow {
  readonly id: string;
  readonly job_id: string;
  readonly job_title: string;
  readonly platform: string;
  readonly stage: string;
  readonly value_minor: string | null;
  readonly currency: string | null;
  readonly retainer: boolean;
  readonly retainer_monthly_minor: string | null;
  readonly stage_changed_at: string;
  readonly order_id: string | null;
  readonly order_status: string | null;
}

export function registerDeliveryRoutes(app: FastifyInstance, options: ServerOptions): void {
  /** The pipeline board: every item with its stage, value and live delivery order. */
  app.get('/v1/pipeline', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    try {
      const rows = await withUser(options.db, authUserId, async (tx) => {
        await reader(tx);
        const { rows } = await tx.query<PipelineRow>(
          `select p.id, p.job_id, j.title as job_title, j.platform::text as platform, p.stage::text as stage,
                  p.value_minor::text as value_minor, p.currency::text as currency, p.retainer,
                  p.retainer_monthly_minor::text as retainer_monthly_minor, p.stage_changed_at,
                  o.id as order_id, o.status::text as order_status
             from pipeline_items p
             join jobs j on j.id = p.job_id
             left join delivery_orders o on o.pipeline_item_id = p.id and o.status <> 'cancelled'
            order by p.stage_changed_at desc, p.id
            limit 500`,
        );
        return rows;
      });
      return reply.send({
        stages: PIPELINE_STAGES,
        items: rows.map((r) => ({
          id: r.id,
          jobId: r.job_id,
          jobTitle: r.job_title,
          platform: r.platform,
          stage: r.stage,
          valueMinor: r.value_minor,
          currency: r.currency?.trim() ?? null,
          retainer: r.retainer,
          retainerMonthlyMinor: r.retainer_monthly_minor,
          stageChangedAt: r.stage_changed_at,
          deliveryOrderId: r.order_id,
          deliveryStatus: r.order_status,
        })),
      });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** Moves an item on the board by hand. */
  app.patch('/v1/pipeline-items/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const stage = (request.body as { stage?: unknown } | null)?.stage;
    if (typeof stage !== 'string' || !(PIPELINE_STAGES as readonly string[]).includes(stage))
      return reply
        .code(422)
        .send(
          invalid([{ field: 'stage', message: `must be one of ${PIPELINE_STAGES.join(', ')}` }]),
        );
    try {
      await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const found = await tx.query('select 1 from pipeline_items where id = $1', [id]);
        if (!found.rows[0]) throw refuse(404, 'no such pipeline item');
        await moveStage(tx, me, id, stage, request.id, 'web');
      });
      return reply.send({ id, stage });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** "Choose supplier" (docs/01 section I): a draft delivery order from a candidate's quote. */
  app.post('/v1/sourcing-requests/:id/candidates/:candidateId/choose', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id, candidateId } = request.params as { id: string; candidateId: string };
    if (!UUID.test(id) || !UUID.test(candidateId))
      return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const order = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const { rows } = await tx.query<{
          request_status: string;
          brief_id: string;
          job_id: string | null;
          supplier_id: string | null;
          display_name: string;
          quoted_price_minor: string | null;
          currency: string | null;
        }>(
          `select r.status::text as request_status, r.brief_id, t.job_id, c.supplier_id, c.display_name,
                    c.quoted_price_minor::text as quoted_price_minor, c.currency::text as currency
               from supplier_candidates c
               join sourcing_requests r on r.id = c.sourcing_request_id
               join briefs b on b.id = r.brief_id
               join threads t on t.id = b.thread_id
              where c.id = $2 and c.sourcing_request_id = $1`,
          [id, candidateId],
        );
        const c = rows[0];
        if (!c) throw refuse(404, 'no such candidate on this request');
        if (!['open', 'shortlisting'].includes(c.request_status))
          throw refuse(
            409,
            `This request is ${c.request_status}, so a supplier cannot be chosen on it.`,
          );
        if (c.quoted_price_minor === null || c.currency === null)
          throw refuse(
            409,
            'This candidate has no quote yet, so there is no cost to agree. Ask for one first.',
          );
        if (c.job_id === null)
          throw refuse(
            409,
            'The conversation behind this brief has no job, so there is no pipeline item to deliver against.',
          );
        const item = await tx.query<{ id: string }>(
          'select id from pipeline_items where job_id = $1',
          [c.job_id],
        );
        const itemId = item.rows[0]?.id;
        if (!itemId)
          throw refuse(
            409,
            'This job has no pipeline item yet: it appears when the bid is submitted.',
          );
        const live = await tx.query(
          `select 1 from delivery_orders where pipeline_item_id = $1 and status <> 'cancelled'`,
          [itemId],
        );
        if (live.rows[0])
          throw refuse(
            409,
            'This job already has a delivery order. Cancel it on the pipeline page before choosing another supplier.',
          );
        const brief = await loadBrief(tx, c.brief_id);
        if (!brief) throw refuse(404, 'no such brief');
        const input = briefInputOf(brief);
        const cost = Number(c.quoted_price_minor);
        const milestones: DeliveryMilestone[] = [
          { title: 'Full delivery', amountMinor: cost, due: input.deadline, status: 'pending' },
        ];
        const inserted = await tx.query<{ id: string }>(
          `insert into delivery_orders (org_id, pipeline_item_id, supplier_id, brief_id, sourcing_request_id,
                                          supplier_candidate_id, agreed_cost_minor, currency, milestones, handover, due_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                     case when $11::date is null then null
                          else ($11::date)::timestamp at time zone 'Africa/Johannesburg' end)
             returning id`,
          [
            me.orgId,
            itemId,
            c.supplier_id,
            c.brief_id,
            id,
            candidateId,
            c.quoted_price_minor,
            c.currency.trim(),
            JSON.stringify(milestones),
            JSON.stringify(handoverChecklist(input)),
            input.deadline,
          ],
        );
        const orderId = inserted.rows[0]!.id;
        await tx.query(`update sourcing_requests set status = 'chosen' where id = $1`, [id]);
        await tx.query(`update supplier_candidates set shortlisted = true where id = $1`, [
          candidateId,
        ]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'delivery.order_created',
          actorUserId: me.userId,
          subjectTable: 'delivery_orders',
          subjectId: orderId,
          requestId: request.id,
          payload: {
            via: 'web',
            sourcing_request_id: id,
            supplier_candidate_id: candidateId,
            supplier: c.display_name,
            agreed_cost_minor: c.quoted_price_minor,
            currency: c.currency.trim(),
          },
        });
        return loadOrder(tx, orderId);
      });
      return reply.code(201).send({ order: describeOrder(order) });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get('/v1/delivery-orders', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const status = (request.query as { status?: string }).status ?? 'all';
    if (status !== 'all' && !(DELIVERY_STATUSES as readonly string[]).includes(status))
      return reply
        .code(422)
        .send(
          invalid([
            { field: 'status', message: `must be all or one of ${DELIVERY_STATUSES.join(', ')}` },
          ]),
        );
    try {
      const rows = await withUser(options.db, authUserId, async (tx) => {
        await reader(tx);
        const { rows } = await tx.query<OrderRow>(
          `${ORDER_SQL} where ($1 = 'all' or o.status::text = $1) order by o.created_at desc, o.id limit 200`,
          [status],
        );
        return rows;
      });
      return reply.send({ orders: rows.map(describeOrder) });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get('/v1/delivery-orders/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        await reader(tx);
        return loadOrder(tx, id);
      });
      return reply.send({ order: describeOrder(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** The cost, the currency, the milestones and the due date, while the order is not started. */
  app.patch('/v1/delivery-orders/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateDeliveryOrderEdit(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const edit = validated.value;
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const before = await loadOrder(tx, id);
        if (!['draft', 'assigned'].includes(before.status))
          throw refuse(
            409,
            `This order is ${before.status.replace('_', ' ')}, so its cost and milestones are fixed.`,
          );
        await tx.query(
          `update delivery_orders set agreed_cost_minor = $2, currency = $3, milestones = $4::jsonb,
                  due_at = case when $5::date is null then null
                                else ($5::date)::timestamp at time zone 'Africa/Johannesburg' end
            where id = $1`,
          [id, edit.agreedCostMinor, edit.currency, JSON.stringify(edit.milestones), edit.due],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'delivery.order_edited',
          actorUserId: me.userId,
          subjectTable: 'delivery_orders',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            agreed_cost_minor: String(edit.agreedCostMinor),
            currency: edit.currency,
            milestones: edit.milestones.length,
          },
        });
        return loadOrder(tx, id);
      });
      return reply.send({ order: describeOrder(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** One move of the order, checked by `transitionBlockers`; the pipeline follows. */
  app.post('/v1/delivery-orders/:id/status', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const to = (request.body as { status?: unknown } | null)?.status;
    if (typeof to !== 'string' || !(DELIVERY_STATUSES as readonly string[]).includes(to))
      return reply
        .code(422)
        .send(
          invalid([{ field: 'status', message: `must be one of ${DELIVERY_STATUSES.join(', ')}` }]),
        );
    const target = to as DeliveryStatus;
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const before = await loadOrder(tx, id);
        const reasons = transitionBlockers(stateOf(before), target);
        if (reasons.length > 0) throw refuse(409, reasons.join(' '));
        const stamp = {
          in_progress: 'handed_over_at',
          delivered: 'delivered_at',
          accepted: 'accepted_at',
          cancelled: 'cancelled_at',
        }[target as string];
        await tx.query(
          `update delivery_orders set status = $2::delivery_order_status${stamp ? `, ${stamp} = now()` : ''} where id = $1`,
          [id, target],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'delivery.status_changed',
          actorUserId: me.userId,
          subjectTable: 'delivery_orders',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', from: before.status, to: target },
        });
        const stage = pipelineStageFor(target);
        if (stage) await moveStage(tx, me, before.pipeline_item_id, stage, request.id, 'delivery');
        // A cancelled order reopens its sourcing request, so another supplier can be chosen.
        if (target === 'cancelled' && before.sourcing_request_id)
          await tx.query(
            `update sourcing_requests set status = 'shortlisting' where id = $1 and status = 'chosen'`,
            [before.sourcing_request_id],
          );
        return loadOrder(tx, id);
      });
      return reply.send({ order: describeOrder(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** Ticks or unticks one handover item, until the supplier starts. */
  app.patch('/v1/delivery-orders/:id/handover/:key', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id, key } = request.params as { id: string; key: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const done = (request.body as { done?: unknown } | null)?.done;
    if (typeof done !== 'boolean')
      return reply.code(422).send(invalid([{ field: 'done', message: 'must be true or false' }]));
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const before = await loadOrder(tx, id);
        if (!['draft', 'assigned'].includes(before.status))
          throw refuse(
            409,
            `This order is ${before.status.replace('_', ' ')}, so its handover is closed.`,
          );
        if (!before.handover.some((item) => item.key === key))
          throw refuse(404, 'no such handover item on this order');
        const handover = before.handover.map((item) =>
          item.key === key ? { ...item, done } : item,
        );
        await tx.query(`update delivery_orders set handover = $2::jsonb where id = $1`, [
          id,
          JSON.stringify(handover),
        ]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'delivery.handover_ticked',
          actorUserId: me.userId,
          subjectTable: 'delivery_orders',
          subjectId: id,
          requestId: request.id,
          payload: { via: 'web', key, done },
        });
        return loadOrder(tx, id);
      });
      return reply.send({ order: describeOrder(row) });
    } catch (error) {
      return send(reply, error);
    }
  });

  /** Marks one milestone delivered or accepted while the work is under way. */
  app.patch('/v1/delivery-orders/:id/milestones/:index', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id, index } = request.params as { id: string; index: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const at = /^\d+$/.test(index) ? Number(index) : -1;
    const status = (request.body as { status?: unknown } | null)?.status;
    if (typeof status !== 'string' || !(MILESTONE_STATUSES as readonly string[]).includes(status))
      return reply
        .code(422)
        .send(
          invalid([
            { field: 'status', message: `must be one of ${MILESTONE_STATUSES.join(', ')}` },
          ]),
        );
    try {
      const row = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const before = await loadOrder(tx, id);
        if (!['in_progress', 'delivered'].includes(before.status))
          throw refuse(
            409,
            'A milestone is marked once the work has started and until the order is accepted.',
          );
        const milestone = before.milestones[at];
        if (!milestone) throw refuse(404, 'no such milestone on this order');
        if (milestone.status === 'accepted')
          throw refuse(409, 'This milestone is accepted; it does not change after that.');
        const milestones = before.milestones.map((m, i) =>
          i === at ? { ...m, status: status as MilestoneStatus } : m,
        );
        await tx.query(`update delivery_orders set milestones = $2::jsonb where id = $1`, [
          id,
          JSON.stringify(milestones),
        ]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'delivery.milestone_changed',
          actorUserId: me.userId,
          subjectTable: 'delivery_orders',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: 'web',
            index: at,
            title: milestone.title,
            from: milestone.status,
            to: status,
          },
        });
        return loadOrder(tx, id);
      });
      return reply.send({ order: describeOrder(row) });
    } catch (error) {
      return send(reply, error);
    }
  });
}
