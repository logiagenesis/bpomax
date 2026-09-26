// @ts-check
/** The demo's threads routes (D-043), split out of demo.js (ARB-531). */
import {
  briefFromDiscovery,
  briefLockBlockers,
  discoveryCompleteness,
  validateBrief,
  validateDiscoveryAnswers,
  validateMessageDraft,
} from '@arbitron/core';
import { logEvent } from '../shared.js';
import { uuid } from '../store.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function threadRoutes(ctx) {
  const {
    method,
    url,
    body,
    store,
    path,
    key,
    idIn,
    respond,
    outbound,
    threads,
    inbound,
    discovery,
    briefs,
    describeThread,
    threadMessages,
    describeSession,
    describeBrief,
    versionOf,
    draftBatch,
  } = ctx;
  if (key === 'GET /v1/threads') {
    const wanted = url.searchParams.get('status');
    const rows = threads
      .map(describeThread)
      .filter((t) => !wanted || t.status === wanted)
      .sort((a, b) => String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')));
    return respond(200, { threads: rows, page: { limit: 50, offset: 0 } });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    return respond(200, { thread: describeThread(t), messages: threadMessages(t.id) });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/messages$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    const validated = validateMessageDraft(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const now = new Date().toISOString();
    const lastIn = inbound.filter((m) => m.threadId === t.id && m.direction === 'in').at(-1);
    const row = {
      id: uuid(),
      threadId: t.id,
      externalThreadId: t.externalThreadId,
      clientHandle: t.clientHandle,
      jobId: t.jobId,
      jobTitle: t.jobTitle,
      body: validated.value.text,
      state: 'queued',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      sentAt: null,
      rejectedAt: null,
      failureReason: null,
      externalMessageId: null,
      createdAt: now,
      updatedAt: now,
      lastInbound: lastIn ? { body: lastIn.body, sentAt: lastIn.sentAt } : null,
    };
    outbound.unshift(row);
    store.outbound = outbound;
    logEvent(store, 'message.drafted', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'web', thread_id: t.id, bodyLength: row.body.length },
    });
    return respond(201, { message: row });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+\/discovery$/.test(path)) {
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    return respond(200, { session: session ? describeSession(session) : null });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/discovery$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    if (discovery.some((d) => d.threadId === t.id))
      return respond(409, { error: 'Discovery has already started on this thread.' });
    const now = new Date().toISOString();
    const session = {
      id: uuid(),
      threadId: t.id,
      version: '1',
      answers: {},
      asked: {},
      createdAt: now,
      updatedAt: now,
    };
    discovery.push(session);
    store.discovery = discovery;
    const draft = draftBatch(t, session);
    logEvent(store, 'discovery.updated', {
      subject_table: 'discovery_sessions',
      subject_id: session.id,
      payload: { via: 'web', started: true, drafted: draft?.keys ?? [] },
    });
    return respond(201, { session: describeSession(session), draft });
  }
  if (method === 'PATCH' && /^\/v1\/threads\/[^/]+\/discovery\/answers$/.test(path)) {
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    if (!session) return respond(404, { error: 'Discovery has not started on this thread.' });
    const validated = validateDiscoveryAnswers(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const now = new Date().toISOString();
    for (const [k, answer] of Object.entries(validated.value)) {
      session.answers[k] = { answer, source: 'operator', capturedAt: now };
    }
    session.updatedAt = now;
    logEvent(store, 'discovery.updated', {
      subject_table: 'discovery_sessions',
      subject_id: session.id,
      payload: {
        via: 'web',
        captured: Object.keys(validated.value),
        completeness: discoveryCompleteness(session.answers),
      },
    });
    return respond(200, { session: describeSession(session) });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/discovery\/next$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    if (!t || !session) return respond(404, { error: 'Discovery has not started on this thread.' });
    const draft = draftBatch(t, session);
    if (!draft)
      return respond(409, {
        error: 'Every question has been answered; there is nothing left to ask.',
      });
    return respond(201, { session: describeSession(session), draft });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+\/brief$/.test(path)) {
    const rows = briefs
      .filter((b) => b.threadId === idIn('/v1/threads/'))
      .sort((a, b) => b.version - a.version);
    return respond(200, {
      brief: rows[0] ? describeBrief(rows[0]) : null,
      versions: rows.map(versionOf),
    });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/brief$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    if (briefs.some((b) => b.threadId === t.id))
      return respond(409, {
        error:
          'This thread already has a brief. Edit it, or start a new version from the locked one.',
      });
    const session = discovery.find((d) => d.threadId === t.id);
    const draft = briefFromDiscovery(session?.answers ?? {}, t.jobTitle);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      threadId: t.id,
      version: 1,
      locked: false,
      lockedAt: null,
      ...draft,
      outcome: draft.outcome || '(not answered yet)',
      createdAt: now,
      updatedAt: now,
    };
    briefs.push(row);
    store.briefs = briefs;
    logEvent(store, 'brief.drafted', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: 1 },
    });
    return respond(201, { brief: describeBrief(row) });
  }
  if (method === 'GET' && /^\/v1\/briefs\/[^/]+$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'PUT' && /^\/v1\/briefs\/[^/]+$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    if (row.locked)
      return respond(409, {
        error: `Version ${String(row.version)} is locked and cannot be changed. Start a new version to change it.`,
      });
    const validated = validateBrief(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    Object.assign(row, validated.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'brief.updated', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version },
    });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/lock$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    if (row.locked)
      return respond(409, { error: `Version ${String(row.version)} is already locked.` });
    const missing = briefLockBlockers(/** @type {any} */ (row));
    if (missing.length > 0) {
      return respond(422, {
        error: `The brief cannot lock without ${missing.join(', ')}.`,
        errors: missing.map((what) => ({ field: 'lock', message: `needs ${what}` })),
      });
    }
    row.locked = true;
    row.lockedAt = new Date().toISOString();
    row.updatedAt = row.lockedAt;
    logEvent(store, 'brief.locked', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version },
    });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/versions$/.test(path)) {
    const from = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!from) return respond(404, { error: 'no such brief' });
    const current = briefs
      .filter((b) => b.threadId === from.threadId)
      .sort((a, b) => b.version - a.version)[0];
    if (current && !current.locked)
      return respond(409, {
        error: `Version ${String(current.version)} is still open. Edit it, or lock it before starting another.`,
      });
    const now = new Date().toISOString();
    const row = {
      ...from,
      id: uuid(),
      version: (current?.version ?? 0) + 1,
      locked: false,
      lockedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    briefs.push(row);
    logEvent(store, 'brief.drafted', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version, from: `version ${String(from.version)}` },
    });
    return respond(201, { brief: describeBrief(row) });
  }
  return undefined;
}
