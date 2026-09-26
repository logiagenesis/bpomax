// @ts-check
/** The demo's pipeline routes (D-043), split out of demo.js (ARB-531). */
import {
  PIPELINE_STAGES,
  handoverChecklist,
  pipelineStageFor,
  transitionBlockers,
  validateDeliveryOrderEdit,
  validateRetainer,
} from '@arbitron/core';
import { logEvent } from '../shared.js';
import { uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function pipelineRoutes(ctx) {
  const {
    method,
    url,
    body,
    store,
    path,
    key,
    idIn,
    respond,
    sourcing,
    pipeline,
    orders,
    describeOrder,
    moveStage,
    orderIn,
  } = ctx;
  // ARB-310 in the demo: the pipeline and delivery orders, by core's rules.
  if (key === 'GET /v1/pipeline') {
    return respond(200, {
      stages: PIPELINE_STAGES,
      items: pipeline.map((item) => {
        const live = orders.find((o) => o.pipelineItemId === item.id && o.status !== 'cancelled');
        return { ...item, deliveryOrderId: live?.id ?? null, deliveryStatus: live?.status ?? null };
      }),
    });
  }
  if (method === 'PATCH' && /^\/v1\/pipeline-items\/[^/]+$/.test(path)) {
    const item = pipeline.find((p) => p.id === path.split('/').pop());
    if (!item) return respond(404, { error: 'no such pipeline item' });
    if (body?.stage === undefined && body?.retainer === undefined)
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'stage', message: 'send a stage, a retainer, or both' }],
      });
    if (body?.stage !== undefined && !PIPELINE_STAGES.includes(body.stage)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'stage', message: `must be one of ${PIPELINE_STAGES.join(', ')}` }],
      });
    }
    if (body?.retainer !== undefined) {
      const validated = validateRetainer(body);
      if (!validated.ok)
        return respond(422, { error: 'the request was not accepted', errors: validated.errors });
      const currency =
        item.currency ?? (typeof body.currency === 'string' ? body.currency.toUpperCase() : null);
      if (validated.value.retainer && !currency)
        return respond(422, {
          error: 'the request was not accepted',
          errors: [
            {
              field: 'currency',
              message: 'the job has no currency recorded; send the retainer’s currency with it',
            },
          ],
        });
      const from = { retainer: item.retainer, monthly_minor: item.retainerMonthlyMinor };
      item.retainer = validated.value.retainer;
      item.retainerMonthlyMinor =
        validated.value.retainerMonthlyMinor === null
          ? null
          : String(validated.value.retainerMonthlyMinor);
      item.currency = currency;
      logEvent(store, 'pipeline.retainer_changed', {
        subject_table: 'pipeline_items',
        subject_id: item.id,
        payload: {
          via: 'web',
          from,
          to: { retainer: item.retainer, monthly_minor: item.retainerMonthlyMinor },
        },
      });
    }
    if (body?.stage !== undefined) moveStage(item, body.stage);
    return respond(200, {
      id: item.id,
      stage: item.stage,
      retainer: item.retainer,
      retainerMonthlyMinor: item.retainerMonthlyMinor,
      currency: item.currency,
    });
  }
  if (
    method === 'POST' &&
    /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+\/choose$/.test(path)
  ) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').at(-2);
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (!['open', 'shortlisting'].includes(row.status))
      return respond(409, {
        error: `This request is ${String(row.status)}, so a supplier cannot be chosen on it.`,
      });
    if (candidate.quotedPriceMinor === null)
      return respond(409, {
        error: 'This candidate has no quote yet, so there is no cost to agree. Ask for one first.',
      });
    const t = (store.threads ?? []).find((x) => x.id === row.threadId);
    const item = pipeline.find((p) => p.jobId === t?.jobId);
    if (!item)
      return respond(409, {
        error: 'This job has no pipeline item yet: it appears when the bid is submitted.',
      });
    if (orders.some((o) => o.pipelineItemId === item.id && o.status !== 'cancelled'))
      return respond(409, {
        error:
          'This job already has a delivery order. Cancel it on the pipeline page before choosing another supplier.',
      });
    const b = (store.briefs ?? []).find((x) => x.id === row.briefId);
    const order = {
      id: uuid(),
      pipelineItemId: item.id,
      status: 'draft',
      briefTitle: b?.title ?? null,
      supplierName: candidate.name,
      supplierId: candidate.supplierId ?? null,
      supplierCandidateId: candidate.id,
      sourcingRequestId: row.id,
      agreedCostMinor: candidate.quotedPriceMinor,
      currency: candidate.currency,
      due: b?.deadline ?? null,
      milestones: [
        {
          title: 'Full delivery',
          amountMinor: Number(candidate.quotedPriceMinor),
          due: b?.deadline ?? null,
          status: 'pending',
        },
      ],
      handover: b ? handoverChecklist(/** @type {any} */ (b)) : [],
      handedOverAt: null,
      deliveredAt: null,
      acceptedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.unshift(order);
    row.status = 'chosen';
    candidate.shortlisted = true;
    logEvent(store, 'delivery.order_created', {
      subject_table: 'delivery_orders',
      subject_id: order.id,
      payload: {
        via: 'web',
        sourcing_request_id: row.id,
        supplier: candidate.name,
        agreed_cost_minor: candidate.quotedPriceMinor,
        currency: candidate.currency,
      },
    });
    return respond(201, { order: describeOrder(order) });
  }
  if (key === 'GET /v1/delivery-orders') {
    const wanted = url.searchParams.get('status') ?? 'all';
    return respond(200, {
      orders: orders.filter((o) => wanted === 'all' || o.status === wanted).map(describeOrder),
    });
  }
  if (method === 'GET' && /^\/v1\/delivery-orders\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    const validated = validateDeliveryOrderEdit(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    if (!['draft', 'assigned'].includes(o.status))
      return respond(409, {
        error: `This order is ${String(o.status).replace('_', ' ')}, so its cost and milestones are fixed.`,
      });
    o.agreedCostMinor = String(validated.value.agreedCostMinor);
    o.currency = validated.value.currency;
    o.milestones = validated.value.milestones;
    o.due = validated.value.due;
    o.updatedAt = new Date().toISOString();
    logEvent(store, 'delivery.order_edited', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: {
        via: 'web',
        agreed_cost_minor: o.agreedCostMinor,
        milestones: o.milestones.length,
      },
    });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'POST' && /^\/v1\/delivery-orders\/[^/]+\/status$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    const to = body?.status;
    const described = describeOrder(o);
    const reasons = described.moves[to];
    if (!reasons)
      return respond(409, {
        error: transitionBlockers(
          /** @type {any} */ ({
            ...o,
            pipelineStage: described.pipelineStage,
            supplierChosen: true,
            agreedCostMinor: Number(o.agreedCostMinor),
          }),
          to,
        ).join(' '),
      });
    if (reasons.length > 0) return respond(409, { error: reasons.join(' ') });
    const from = o.status;
    o.status = to;
    const now = new Date().toISOString();
    if (to === 'in_progress') o.handedOverAt = now;
    if (to === 'delivered') o.deliveredAt = now;
    if (to === 'accepted') o.acceptedAt = now;
    if (to === 'cancelled') {
      o.cancelledAt = now;
      const request = sourcing.find((r) => r.id === o.sourcingRequestId);
      if (request?.status === 'chosen') request.status = 'shortlisting';
    }
    logEvent(store, 'delivery.status_changed', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', from, to },
    });
    const stage = pipelineStageFor(to);
    const item = pipeline.find((p) => p.id === o.pipelineItemId);
    if (stage && item) moveStage(item, stage);
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+\/handover\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    if (!['draft', 'assigned'].includes(o.status))
      return respond(409, {
        error: `This order is ${String(o.status).replace('_', ' ')}, so its handover is closed.`,
      });
    const itemKey = decodeURIComponent(path.split('/').pop() ?? '');
    const entry = o.handover.find((/** @type {Row} */ h) => h.key === itemKey);
    if (!entry) return respond(404, { error: 'no such handover item on this order' });
    entry.done = body?.done === true;
    logEvent(store, 'delivery.handover_ticked', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', key: itemKey, done: entry.done },
    });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+\/milestones\/\d+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    if (!['in_progress', 'delivered'].includes(o.status))
      return respond(409, {
        error: 'A milestone is marked once the work has started and until the order is accepted.',
      });
    const m = o.milestones[Number(path.split('/').pop())];
    if (!m) return respond(404, { error: 'no such milestone on this order' });
    if (m.status === 'accepted')
      return respond(409, { error: 'This milestone is accepted; it does not change after that.' });
    const from = m.status;
    m.status = body?.status;
    logEvent(store, 'delivery.milestone_changed', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', title: m.title, from, to: m.status },
    });
    return respond(200, { order: describeOrder(o) });
  }
  return undefined;
}
