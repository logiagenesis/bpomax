// @ts-check
/** The demo's proposals routes (D-043), split out of demo.js (ARB-531). */
import { logEvent } from '../shared.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function proposalRoutes(ctx) {
  const { method, url, body, store, path, key, idIn, respond, decide } = ctx;
  if (key === 'GET /v1/proposals') {
    const status = url.searchParams.get('status') ?? 'queued';
    return respond(200, {
      proposals: store.proposals.filter((p) => status === 'all' || p.status === status),
      biddingPaused: store.biddingPaused,
    });
  }
  if (key === 'POST /v1/proposals/bulk') {
    const results = /** @type {string[]} */ (body?.ids ?? []).map((id) => {
      const row = store.proposals.find((p) => p.id === id);
      if (!row) return { id, ok: false, error: 'no such bid' };
      const error = decide(row, body.action, body.reason);
      return error ? { id, ok: false, error } : { id, ok: true };
    });
    return respond(200, { results });
  }
  if (method === 'POST' && /^\/v1\/proposals\/[^/]+\/(approve|reject)$/.test(path)) {
    const row = store.proposals.find((p) => p.id === idIn('/v1/proposals/'));
    if (!row) return respond(404, { error: 'no such bid' });
    const action = path.endsWith('/approve') ? 'approve' : 'reject';
    if (action === 'reject' && !String(body?.reason ?? '').trim()) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'reason', message: 'must not be empty' }],
      });
    }
    const error = decide(row, action, body?.reason);
    if (error) return respond(409, { error });
    return respond(200, {
      proposal: row,
      ...(action === 'approve' ? { biddingPaused: store.biddingPaused, queued: true } : {}),
    });
  }
  if (method === 'PATCH' && /^\/v1\/proposals\/[^/]+$/.test(path)) {
    const row = store.proposals.find((p) => p.id === idIn('/v1/proposals/'));
    if (!row) return respond(404, { error: 'no such bid' });
    if (row.status === 'submitted') return respond(409, { error: 'This bid is submitted.' });
    row.body = String(body?.body ?? row.body);
    row.status = 'queued';
    row.approved_by = null;
    row.approved_by_name = null;
    row.approved_via = null;
    logEvent(store, 'proposal.edited', { subject_table: 'proposals', subject_id: row.id });
    return respond(200, { proposal: row });
  }
  return undefined;
}
