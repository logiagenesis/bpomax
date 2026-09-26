// @ts-check
/** The demo's payments routes (D-043), split out of demo.js (ARB-531). */
import { directionOf, sastDay, validatePaymentInput, zarOf } from '@arbitron/core';
import { logEvent } from '../shared.js';
import { uuid } from '../store.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function paymentRoutes(ctx) {
  const {
    method,
    body,
    store,
    path,
    respond,
    pipeline,
    orders,
    moveStage,
    payments,
    paymentsView,
  } = ctx;
  // ARB-311 in the demo: payments and realised margin, by core's rules. No FX provider.
  if (method === 'GET' && /^\/v1\/pipeline-items\/[^/]+\/payments$/.test(path)) {
    const item = pipeline.find((x) => x.id === path.split('/')[3]);
    if (!item) return respond(404, { error: 'no such pipeline item' });
    return respond(200, paymentsView(item));
  }
  if (method === 'POST' && /^\/v1\/pipeline-items\/[^/]+\/payments$/.test(path)) {
    const item = pipeline.find((x) => x.id === path.split('/')[3]);
    if (!item) return respond(404, { error: 'no such pipeline item' });
    const validated = validatePaymentInput(body, { today: sastDay(new Date()) });
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const v = validated.value;
    if (v.currency !== 'ZAR' && v.fxRate === null)
      return respond(422, {
        error: 'the request was not accepted',
        errors: [
          {
            field: 'fxRate',
            message: `must be typed: a ${v.currency} payment needs the rate to ZAR it was converted at, and no FX provider is configured (docs/02 B-10)`,
          },
        ],
      });
    let notice = null;
    if (v.kind === 'supplier') {
      const o = orders.find((x) => x.id === v.deliveryOrderId && x.pipelineItemId === item.id);
      if (!o)
        return respond(422, {
          error: 'the request was not accepted',
          errors: [{ field: 'deliveryOrderId', message: 'must be a delivery order of this job' }],
        });
      if (o.status === 'draft')
        return respond(409, {
          error: 'A supplier is paid once assigned. Assign the supplier first.',
        });
      const supplier = (store.suppliers ?? []).find((x) => x.id === o.supplierId);
      if (supplier?.countryCode !== 'ZA')
        notice =
          'docs/02 T-05 is open: the legal structure for paying overseas suppliers (Exchange Control/SARB reporting, invoicing, VAT treatment of export services) is to be confirmed with Logi-Ink’s accountant before the first live supplier payment.';
    }
    const zar = zarOf(v.amountMinor, v.currency, v.fxRate);
    const row = {
      id: uuid(),
      pipelineItemId: item.id,
      kind: v.kind,
      direction: directionOf(v.kind),
      amountMinor: String(v.amountMinor),
      currency: v.currency,
      fxRateUsed: v.fxRate,
      fxRateAt: v.fxRate ? new Date(`${v.paidOn}T00:00:00+02:00`).toISOString() : null,
      amountZarMinor: zar === null ? null : String(zar),
      paidAt: new Date(`${v.paidOn}T00:00:00+02:00`).toISOString(),
      reference: v.reference,
      deliveryOrderId: v.deliveryOrderId,
      milestoneIndex: v.milestoneIndex,
      recordedByName: 'Demo Owner',
      createdAt: new Date().toISOString(),
    };
    payments.push(row);
    logEvent(store, 'payment.recorded', {
      subject_table: 'payments',
      subject_id: row.id,
      payload: { via: 'web', kind: v.kind, amount_minor: row.amountMinor, currency: v.currency },
    });
    const view = paymentsView(item);
    if (v.kind === 'client' && item.stage !== 'paid' && view.paidInFull) {
      moveStage(item, 'paid');
      view.item.stage = 'paid';
    }
    return respond(201, { ...view, paymentId: row.id, notice });
  }
  return undefined;
}
