import {
  HOME_CURRENCY,
  canWrite,
  clientPaidInFull,
  directionOf,
  realisedMargin,
  sastDay,
  validatePaymentInput,
  zarOf,
  type DeliveryMilestone,
  type PaymentKind,
} from '@arbitron/core';
import { recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { currentMembership, invalid, UUID, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';
import { moveStage } from './delivery.js';

/**
 * Payments in and out, and realised margin (ARB-311, docs/05 section 3.5: "payments in −
 * payments out − fees = realised margin"). A payment is recorded by hand once made: a
 * client's against the job, a supplier's against its delivery order and milestone, a
 * platform fee or other cost against the job. A payment not in rand carries the rate it
 * was converted at and when (05 section 3.4): typed with it, or from the FX provider
 * (B-10); with neither it is refused, never guessed. The job moves to Paid once the
 * client's payments in its own currency reach its value. Nothing here moves money.
 */
interface ItemRow {
  readonly id: string;
  readonly job_title: string;
  readonly stage: string;
  readonly value_minor: string | null;
  readonly currency: string | null;
}

interface PaymentRow {
  readonly id: string;
  readonly kind: PaymentKind;
  readonly direction: 'in' | 'out';
  readonly amount_minor: string;
  readonly currency: string;
  readonly fx_rate_used: string | null;
  readonly fx_rate_at: string | null;
  readonly amount_zar_minor: string | null;
  readonly paid_at: string;
  readonly reference: string | null;
  readonly delivery_order_id: string | null;
  readonly milestone_index: number | null;
  readonly recorded_by_name: string | null;
  readonly created_at: string;
}

interface OrderRow {
  readonly id: string;
  readonly status: string;
  readonly currency: string | null;
  readonly milestones: DeliveryMilestone[];
  readonly supplier_name: string | null;
  readonly supplier_country: string | null;
}

/** docs/02 T-05, as its row states it, shown with a payment to a supplier outside South Africa. */
export const T05_NOTICE =
  'docs/02 T-05 is open: the legal structure for paying overseas suppliers (Exchange Control/SARB reporting, invoicing, VAT treatment of export services) is to be confirmed with Logi-Ink’s accountant before the first live supplier payment.';

async function loadItem(tx: Queryable, id: string): Promise<ItemRow> {
  const { rows } = await tx.query<ItemRow>(
    `select p.id, j.title as job_title, p.stage::text as stage, p.value_minor::text as value_minor,
            p.currency::text as currency
       from pipeline_items p join jobs j on j.id = p.job_id where p.id = $1`,
    [id],
  );
  if (!rows[0]) throw refuse(404, 'no such pipeline item');
  return rows[0];
}

async function loadOrders(tx: Queryable, itemId: string): Promise<OrderRow[]> {
  const { rows } = await tx.query<OrderRow>(
    `select o.id, o.status::text as status, o.currency::text as currency, o.milestones,
            coalesce(s.name, c.display_name) as supplier_name,
            coalesce(s.country_code, c.country_code)::text as supplier_country
       from delivery_orders o
       left join suppliers s on s.id = o.supplier_id
       left join supplier_candidates c on c.id = o.supplier_candidate_id
      where o.pipeline_item_id = $1 and o.status <> 'cancelled'
      order by o.created_at`,
    [itemId],
  );
  return rows;
}

async function loadPayments(tx: Queryable, itemId: string): Promise<PaymentRow[]> {
  const { rows } = await tx.query<PaymentRow>(
    `select y.id, y.kind::text as kind, y.direction::text as direction, y.amount_minor::text as amount_minor,
            y.currency::text as currency, y.fx_rate_used::text as fx_rate_used, y.fx_rate_at,
            y.amount_zar_minor::text as amount_zar_minor, y.paid_at, y.reference, y.delivery_order_id,
            y.milestone_index, u.full_name as recorded_by_name, y.created_at
       from payments y left join users u on u.id = y.recorded_by
      where y.pipeline_item_id = $1
      order by y.paid_at, y.created_at`,
    [itemId],
  );
  return rows;
}

const stored = (rows: readonly PaymentRow[]) =>
  rows.map((r) => ({
    kind: r.kind,
    amountMinor: Number(r.amount_minor),
    currency: r.currency.trim(),
    amountZarMinor: r.amount_zar_minor === null ? null : Number(r.amount_zar_minor),
  }));

function describeView(item: ItemRow, orders: OrderRow[], payments: PaymentRow[]) {
  const margin = realisedMargin(stored(payments));
  const currency = item.currency?.trim() ?? null;
  return {
    item: {
      id: item.id,
      jobTitle: item.job_title,
      stage: item.stage,
      valueMinor: item.value_minor,
      currency,
    },
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      currency: o.currency?.trim() ?? null,
      supplierName: o.supplier_name,
      supplierCountry: o.supplier_country?.trim() ?? null,
      milestones: o.milestones.map((m) => ({
        title: m.title,
        amountMinor: m.amountMinor,
        status: m.status,
      })),
    })),
    payments: payments.map((r) => ({
      id: r.id,
      kind: r.kind,
      direction: r.direction,
      amountMinor: r.amount_minor,
      currency: r.currency.trim(),
      fxRateUsed: r.fx_rate_used,
      fxRateAt: r.fx_rate_at,
      amountZarMinor: r.currency.trim() === HOME_CURRENCY ? r.amount_minor : r.amount_zar_minor,
      paidAt: r.paid_at,
      reference: r.reference,
      deliveryOrderId: r.delivery_order_id,
      milestoneIndex: r.milestone_index,
      recordedByName: r.recorded_by_name,
      createdAt: r.created_at,
    })),
    margin: {
      inZarMinor: margin.inZarMinor.toString(),
      supplierZarMinor: margin.supplierZarMinor.toString(),
      feesZarMinor: margin.feesZarMinor.toString(),
      otherZarMinor: margin.otherZarMinor.toString(),
      marginZarMinor: margin.marginZarMinor.toString(),
      unconverted: margin.unconverted.map((p) => ({
        kind: p.kind,
        amountMinor: String(p.amountMinor),
        currency: p.currency,
      })),
    },
    paidInFull: clientPaidInFull(
      stored(payments),
      item.value_minor === null ? null : Number(item.value_minor),
      currency,
    ),
  };
}

function send(reply: FastifyReply, error: unknown) {
  const errors = (error as { errors?: unknown }).errors;
  return reply
    .code(statusOf(error))
    .send(errors ? { error: messageOf(error), errors } : { error: messageOf(error) });
}

export function registerPaymentRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/pipeline-items/:id/payments', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    try {
      const view = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const item = await loadItem(tx, id);
        return describeView(item, await loadOrders(tx, id), await loadPayments(tx, id));
      });
      return reply.send(view);
    } catch (error) {
      return send(reply, error);
    }
  });

  /** Records one payment made, by hand. */
  app.post('/v1/pipeline-items/:id/payments', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const now = options.now ? options.now() : new Date();
    const validated = validatePaymentInput(request.body, { today: sastDay(now) });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const input = validated.value;

    // The rate: typed with the payment, or the FX provider's now (B-10), or refused.
    let rate = input.fxRate;
    let rateAt: string | null = null;
    if (input.currency !== HOME_CURRENCY && rate === null) {
      if (!options.fx)
        return reply.code(422).send(
          invalid([
            {
              field: 'fxRate',
              message: `must be typed: a ${input.currency} payment needs the rate to ZAR it was converted at, and no FX provider is configured (docs/02 B-10)`,
            },
          ]),
        );
      try {
        const quote = await options.fx.quote(input.currency, HOME_CURRENCY);
        rate = quote.rate;
        rateAt = quote.at;
      } catch (error) {
        return reply.code(503).send({
          error: `The FX provider did not give a ${input.currency} to ZAR rate (${(error as Error).message}). Type the rate with the payment.`,
        });
      }
    }
    const zar = zarOf(input.amountMinor, input.currency, rate);

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        if (!canWrite(me.role))
          throw refuse(403, 'your role can view payments but not record them');
        const item = await loadItem(tx, id);
        const orders = await loadOrders(tx, id);
        let notice: string | null = null;
        if (input.kind === 'supplier') {
          const order = orders.find((o) => o.id === input.deliveryOrderId);
          if (!order)
            throw Object.assign(refuse(422, 'the request was not accepted'), {
              errors: [
                { field: 'deliveryOrderId', message: 'must be a delivery order of this job' },
              ],
            });
          if (order.status === 'draft')
            throw refuse(409, 'A supplier is paid once assigned. Assign the supplier first.');
          if (input.milestoneIndex !== null && !order.milestones[input.milestoneIndex])
            throw Object.assign(refuse(422, 'the request was not accepted'), {
              errors: [{ field: 'milestoneIndex', message: 'must be a milestone of the order' }],
            });
          const country = order.supplier_country?.trim() ?? null;
          if (country !== 'ZA') notice = T05_NOTICE;
        }
        const inserted = await tx.query<{ id: string }>(
          `insert into payments (org_id, pipeline_item_id, delivery_order_id, direction, kind, amount_minor, currency,
                                 fx_rate_used, fx_rate_at, amount_zar_minor, paid_at, reference, milestone_index, recorded_by)
           values ($1, $2, $3, $4::payment_direction, $5::payment_kind, $6, $7, $8, $9, $10,
                   ($11::date)::timestamp at time zone 'Africa/Johannesburg', $12, $13, $14)
           returning id`,
          [
            me.orgId,
            id,
            input.deliveryOrderId,
            directionOf(input.kind),
            input.kind,
            input.amountMinor,
            input.currency,
            rate,
            rate === null
              ? null
              : (rateAt ?? new Date(`${input.paidOn}T00:00:00+02:00`).toISOString()),
            zar,
            input.paidOn,
            input.reference,
            input.milestoneIndex,
            me.userId,
          ],
        );
        const paymentId = inserted.rows[0]!.id;
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'payment.recorded',
          actorUserId: me.userId,
          subjectTable: 'payments',
          subjectId: paymentId,
          requestId: request.id,
          payload: {
            via: 'web',
            kind: input.kind,
            amount_minor: String(input.amountMinor),
            currency: input.currency,
            fx_rate_used: rate,
            amount_zar_minor: zar === null ? null : String(zar),
            rate_from:
              input.currency === HOME_CURRENCY ? null : input.fxRate ? 'typed' : 'provider',
          },
        });
        const payments = await loadPayments(tx, id);
        if (
          input.kind === 'client' &&
          item.stage !== 'paid' &&
          clientPaidInFull(
            stored(payments),
            item.value_minor === null ? null : Number(item.value_minor),
            item.currency?.trim() ?? null,
          )
        )
          await moveStage(tx, me, id, 'paid', request.id, 'payments');
        return {
          view: describeView(await loadItem(tx, id), orders, payments),
          paymentId,
          notice,
        };
      });
      return reply
        .code(201)
        .send({ ...result.view, paymentId: result.paymentId, notice: result.notice });
    } catch (error) {
      return send(reply, error);
    }
  });
}
