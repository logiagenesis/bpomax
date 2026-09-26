// @ts-check
/** The demo's replies routes (D-043), split out of demo.js (ARB-531). */
import { validateMessageDraft } from '@arbitron/core';
import { logEvent } from '../shared.js';
import { USER } from '../store.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function replyRoutes(ctx) {
  const { method, url, body, store, path, key, idIn, respond, outbound } = ctx;
  // ARB-122 in the demo: replies waiting for approval, kept in the tab; nothing is sent.
  if (key === 'GET /v1/outbound-messages') {
    const state = url.searchParams.get('status') ?? 'queued';
    return respond(200, { messages: outbound.filter((m) => state === 'all' || m.state === state) });
  }
  if (method === 'POST' && /^\/v1\/outbound-messages\/[^/]+\/(approve|reject)$/.test(path)) {
    const row = outbound.find((m) => m.id === idIn('/v1/outbound-messages/'));
    if (!row) return respond(404, { error: 'no such message' });
    const action = path.endsWith('/approve') ? 'approve' : 'reject';
    if (action === 'approve' && row.state !== 'queued')
      return respond(409, { error: `This message is ${row.state}.` });
    if (action === 'reject' && !String(body?.reason ?? '').trim()) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'reason', message: 'must not be empty' }],
      });
    }
    if (action === 'reject' && (row.state === 'sent' || row.state === 'rejected'))
      return respond(409, { error: `This message is ${row.state}.` });
    if (action === 'approve') {
      row.state = 'approved';
      row.approvedBy = USER;
      row.approvedByName = 'Demo Owner';
      row.approvedVia = 'web';
    } else {
      row.state = 'rejected';
      row.rejectedAt = new Date().toISOString();
      row.failureReason = body.reason;
      row.approvedBy = null;
      row.approvedByName = null;
      row.approvedVia = null;
    }
    row.updatedAt = new Date().toISOString();
    logEvent(store, action === 'approve' ? 'message.approved' : 'message.rejected', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'web', ...(action === 'reject' ? { reason: body.reason } : {}) },
    });
    return respond(200, { message: row, ...(action === 'approve' ? { queued: false } : {}) });
  }
  if (method === 'PATCH' && /^\/v1\/outbound-messages\/[^/]+$/.test(path)) {
    const row = outbound.find((m) => m.id === idIn('/v1/outbound-messages/'));
    if (!row) return respond(404, { error: 'no such message' });
    if (row.state === 'sent') return respond(409, { error: 'This message has already been sent.' });
    const validated = validateMessageDraft(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    row.body = validated.value.text;
    row.state = 'queued';
    row.approvedBy = null;
    row.approvedByName = null;
    row.approvedVia = null;
    row.rejectedAt = null;
    row.failureReason = null;
    row.updatedAt = new Date().toISOString();
    logEvent(store, 'message.edited', { subject_table: 'messages', subject_id: row.id });
    return respond(200, { message: row });
  }
  return undefined;
}
