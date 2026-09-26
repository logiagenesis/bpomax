// @ts-check
/** The demo's sourcing routes (D-043), split out of demo.js (ARB-531). */
import { rankSuppliers } from '@arbitron/core';
import { demoReprice, logEvent } from '../shared.js';
import { event, uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function sourcingRoutes(ctx) {
  const { method, body, store, path, key, idIn, respond, threads, sourcing, describeSourcing } =
    ctx;
  // ARB-201 in the demo: sourcing requests ranked by the real rule from the tab's suppliers.
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/sourcing$/.test(path)) {
    const b = (store.briefs ?? []).find((row) => row.id === idIn('/v1/briefs/'));
    if (!b) return respond(404, { error: 'no such brief' });
    if (!b.locked)
      return respond(409, { error: 'The brief must be locked before sourcing starts.' });
    if (b.deliveryRoute === 'in_house') {
      return respond(422, {
        error: 'This brief is delivered in-house, so nothing is sourced (docs/02 D-04).',
      });
    }
    if (
      sourcing.some(
        (r) => r.briefId === b.id && ['open', 'shortlisting', 'chosen'].includes(r.status),
      )
    ) {
      return respond(409, { error: 'Sourcing has already started for this brief.' });
    }
    const t = threads.find((row) => row.id === b.threadId);
    const ranking = rankSuppliers(
      {
        category: b.category,
        budget: b.budget,
        deadline: b.deadline,
        deadlineFixed: b.deadlineFixed,
      },
      /** @type {any} */ (
        (store.suppliers ?? []).map((sup) => ({
          ...sup,
          rateCards: sup.rateCards.filter((/** @type {Row} */ c) => c.categorySlug === b.category),
        }))
      ),
      { now: new Date() },
    );
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      briefId: b.id,
      briefVersion: b.version,
      briefTitle: b.title,
      category: b.category,
      deliveryRoute: b.deliveryRoute,
      threadId: b.threadId,
      clientHandle: t?.clientHandle ?? null,
      jobTitle: t?.jobTitle ?? null,
      channels: [...new Set(ranking.ranked.map((r) => r.channel))],
      status: 'open',
      excluded: ranking.excluded,
      candidates: ranking.ranked.map((r) => ({
        id: uuid(),
        supplierId: r.supplierId,
        name: r.name,
        channel: r.channel,
        countryCode: r.countryCode,
        timeZone: r.timeZone,
        currency: r.currency,
        quotedPriceMinor: r.quotedPriceMinor,
        priced: r.priced,
        turnaroundDays: r.turnaroundDays,
        score: r.score,
        parts: r.parts,
        reasons: r.reasons,
        shortlisted: false,
      })),
      createdAt: now,
      updatedAt: now,
    };
    sourcing.unshift(row);
    store.sourcing = sourcing;
    logEvent(store, 'sourcing.requested', {
      subject_table: 'sourcing_requests',
      subject_id: row.id,
      payload: {
        via: 'web',
        brief_id: b.id,
        category: b.category,
        ranked: ranking.ranked.length,
        excluded: ranking.excluded.length,
      },
    });
    return respond(201, { request: describeSourcing(row, true) });
  }
  if (method === 'GET' && /^\/v1\/briefs\/[^/]+\/sourcing$/.test(path)) {
    const row = sourcing.find((r) => r.briefId === idIn('/v1/briefs/'));
    return respond(200, { request: row ? describeSourcing(row, true) : null });
  }
  if (key === 'GET /v1/sourcing-requests') {
    return respond(200, { requests: sourcing.map((r) => describeSourcing(r, false)) });
  }
  if (method === 'GET' && /^\/v1\/sourcing-requests\/[^/]+$/.test(path)) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    return respond(200, { request: describeSourcing(row, true) });
  }
  if (method === 'PATCH' && /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+$/.test(path)) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').pop();
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (typeof body?.shortlisted !== 'boolean') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'shortlisted', message: 'must be true or false' }],
      });
    }
    candidate.shortlisted = body.shortlisted;
    row.status = row.candidates.some((/** @type {Row} */ c) => c.shortlisted)
      ? 'shortlisting'
      : 'open';
    row.updatedAt = new Date().toISOString();
    logEvent(store, 'sourcing.shortlisted', {
      subject_table: 'supplier_candidates',
      subject_id: candidate.id,
      payload: { via: 'web', sourcing_request_id: row.id, shortlisted: body.shortlisted },
    });
    return respond(200, { request: describeSourcing(row, true) });
  }

  if (
    method === 'POST' &&
    /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+\/reprice$/.test(path)
  ) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').at(-2);
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (candidate.quotedPriceMinor === null) {
      return respond(409, {
        error: 'This candidate has no quote yet, so there is nothing to reprice with.',
      });
    }
    const t = (store.threads ?? []).find((x) => x.id === row.threadId);
    const j = t?.jobId ? store.jobs.find((x) => x.id === t.jobId) : undefined;
    if (!j) {
      return respond(409, {
        error:
          'The conversation behind this brief has no job, so there is no bid margin to reprice.',
      });
    }
    const { margin, reprice } = demoReprice(store.settings, j, candidate);
    candidate.margin = margin;
    candidate.reprice = reprice;
    store.events.unshift(
      event('margin.repriced', {
        subject_table: 'supplier_candidates',
        subject_id: candidate.id,
        outcome: reprice.outcome,
        payload: {
          candidate: candidate.name,
          sourcing_request_id: row.id,
          ...(reprice.outcome === 'ok'
            ? { quote_minor: candidate.quotedPriceMinor, after: margin }
            : { reason: reprice.reason, detail: reprice.detail, message: reprice.message }),
        },
      }),
    );
    return respond(202, { queued: true });
  }
  return undefined;
}
