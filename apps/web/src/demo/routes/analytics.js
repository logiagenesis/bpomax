// @ts-check
/** The demo's analytics routes (D-043), split out of demo.js (ARB-531). */
import { ANALYTICS_DIMENSIONS, aggregateAnalytics, analyticsTotal } from '@arbitron/core';
import { repliedAfter, templatesOf } from '../shared.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function analyticsRoutes(ctx) {
  const { url, store, key, respond, pipeline, orders, payments } = ctx;
  // ARB-320 in the demo: the tab's sent bids, grouped by core's rule as the API groups them.
  if (key === 'GET /v1/analytics') {
    const by = url.searchParams.get('by') ?? 'category';
    if (!ANALYTICS_DIMENSIONS.includes(/** @type {any} */ (by)))
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'by', message: `must be one of ${ANALYTICS_DIMENSIONS.join(', ')}` }],
      });
    const since = url.searchParams.get('since');
    const start = since ? new Date(`${since}T00:00:00+02:00`).getTime() : null;
    const facts = store.proposals
      .filter(
        (p) =>
          p.status === 'submitted' &&
          p.submitted_at &&
          (start === null || new Date(p.submitted_at).getTime() >= start),
      )
      .map((p) => {
        const j = store.jobs.find((x) => x.id === p.job_id) ?? {};
        const item = pipeline.find((x) => x.jobId === p.job_id);
        const order = item
          ? orders.find((o) => o.pipelineItemId === item.id && o.status !== 'cancelled')
          : undefined;
        const replied = repliedAfter(store, p);
        const template = templatesOf(store).find((x) =>
          x.variants.some((/** @type {Row} */ v) => v.id === p.template_variant_id),
        );
        const mine = payments.filter((y) => item && y.pipelineItemId === item.id);
        const zar = (/** @type {string} */ direction) =>
          mine
            .filter((y) => y.direction === direction && y.amountZarMinor !== null)
            .reduce((sum, y) => sum + BigInt(y.amountZarMinor), 0n)
            .toString();
        const category = j.category_slug ?? null;
        return {
          jobId: p.job_id,
          categoryKey: category,
          categoryLabel: category,
          templateKey: template?.id ?? null,
          templateLabel: template?.name ?? null,
          supplierKey: order?.supplierCandidateId ?? null,
          supplierLabel: order?.supplierName ?? null,
          scannerKey: null,
          scannerLabel: null,
          replied,
          won: item ? ['won', 'in_delivery', 'delivered', 'paid'].includes(item.stage) : false,
          lost: item?.stage === 'lost',
          inZarMinor: zar('in'),
          outZarMinor: zar('out'),
          unconvertedPayments: mine.filter((y) => y.amountZarMinor === null).length,
          modelCostNanoUsd: '0',
        };
      });
    return respond(200, {
      by,
      since,
      total: analyticsTotal(facts),
      rows: aggregateAnalytics(facts, /** @type {any} */ (by)),
    });
  }
  return undefined;
}
