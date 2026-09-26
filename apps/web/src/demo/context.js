// @ts-check
/**
 * One demo request (D-043): the tab's store, the path, the answer, and the rows and
 * helpers more than one group of routes reads, made once per request. Split out of
 * demo.js (ARB-531).
 */
import {
  DISCOVERY_QUESTIONS,
  briefLockBlockers,
  discoveryCompleteness,
  nextDiscoveryBatch,
  DELIVERY_TRANSITIONS,
  clientPaidInFull,
  realisedMargin,
  milestoneTotal,
  reconcileMilestones,
  transitionBlockers,
  renderDiscoveryBatch,
} from '@arbitron/core';
import { DEMO_CATEGORIES, json, logEvent, templatesOf } from './shared.js';
import { USER, load, save, uuid } from './store.js';
/** @typedef {import('./store.js').Row} Row */

/**
 * @param {string} method
 * @param {URL} url
 * @param {any} body
 */
export function makeContext(method, url, body) {
  const store = load();
  const path = url.pathname;
  const key = `${method} ${path}`;
  const idIn = (/** @type {string} */ prefix) => path.slice(prefix.length).split('/')[0];

  /** @param {number} status @param {unknown} payload @param {Record<string, string>} [headers] */
  const respond = (status, payload, headers) => {
    save(store);
    return json(status, payload, headers);
  };

  const outbound = store.outbound ?? [];
  const threads = store.threads ?? [];
  const inbound = store.inbound ?? [];
  const discovery = store.discovery ?? [];
  const briefs = store.briefs ?? [];
  /** @param {Row} t @returns {Row} */
  const describeThread = (t) => {
    const messages = threadMessages(t.id);
    const last = messages.at(-1) ?? null;
    const session = discovery.find((d) => d.threadId === t.id) ?? null;
    const current =
      briefs.filter((b) => b.threadId === t.id).sort((a, b) => b.version - a.version)[0] ?? null;
    return {
      ...t,
      lastMessageAt: last ? (last.sentAt ?? last.createdAt) : null,
      messageCount: messages.length,
      pendingReplies: messages.filter((m) => m.state === 'queued' || m.state === 'approved').length,
      lastMessage: last
        ? { direction: last.direction, body: last.body, sentAt: last.sentAt }
        : null,
      discovery: session ? { completeness: discoveryCompleteness(session.answers) } : null,
      brief: current ? { id: current.id, version: current.version, locked: current.locked } : null,
      updatedAt: last ? (last.sentAt ?? last.createdAt) : t.createdAt,
    };
  };
  /** @param {string} threadId */
  function threadMessages(threadId) {
    const drafts = outbound
      .filter((m) => m.threadId === threadId)
      .map((m) => ({
        id: m.id,
        direction: 'out',
        origin: 'app',
        body: m.body,
        state: m.state,
        sentAt: m.sentAt,
        approvedByName: m.approvedByName,
        approvedVia: m.approvedVia,
        rejectedAt: m.rejectedAt,
        failureReason: m.failureReason,
        createdAt: m.createdAt,
      }));
    return [...inbound.filter((m) => m.threadId === threadId), ...drafts].sort((a, b) =>
      String(a.sentAt ?? a.createdAt).localeCompare(String(b.sentAt ?? b.createdAt)),
    );
  }
  /** @param {Row} session */
  const describeSession = (session) => ({
    id: session.id,
    threadId: session.threadId,
    version: session.version,
    completeness: discoveryCompleteness(session.answers),
    answers: session.answers,
    asked: session.asked,
    questions: DISCOVERY_QUESTIONS.map((q) => ({
      key: q.key,
      text: q.text,
      answer: session.answers[q.key] ?? null,
      askedAt: session.asked[q.key] ?? null,
    })),
    nextBatch: nextDiscoveryBatch(session.answers, session.asked).map((q) => q.key),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  /** @param {Row} b */
  const describeBrief = (b) => ({
    ...b,
    lockBlockers: b.locked ? [] : briefLockBlockers(/** @type {any} */ (b)),
  });
  /** @param {Row} b */
  const versionOf = (b) => ({
    id: b.id,
    version: b.version,
    locked: b.locked,
    lockedAt: b.lockedAt,
    updatedAt: b.updatedAt,
  });
  /** A batch of questions drafted as a reply waiting for approval (ARB-130 in the demo). */
  const draftBatch = (/** @type {Row} */ t, /** @type {Row} */ session) => {
    const batch = nextDiscoveryBatch(session.answers, session.asked);
    if (batch.length === 0) return null;
    const now = new Date().toISOString();
    const body = renderDiscoveryBatch(batch, t.clientHandle);
    const row = {
      id: uuid(),
      threadId: t.id,
      externalThreadId: t.externalThreadId,
      clientHandle: t.clientHandle,
      jobId: t.jobId,
      jobTitle: t.jobTitle,
      body,
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
      lastInbound: null,
    };
    outbound.unshift(row);
    for (const q of batch) session.asked[q.key] = now;
    session.updatedAt = now;
    logEvent(store, 'message.drafted', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'discovery', thread_id: t.id, questions: batch.map((q) => q.key) },
    });
    return { messageId: row.id, keys: batch.map((q) => q.key), body };
  };
  const sourcing = store.sourcing ?? [];
  /** @param {Row} r @param {boolean} withCandidates */
  const describeSourcing = (r, withCandidates) => {
    const { candidates, ...rest } = r;
    return {
      ...rest,
      candidateCount: candidates.length,
      shortlistedCount: candidates.filter((/** @type {Row} */ c) => c.shortlisted).length,
      ...(withCandidates ? { candidates } : {}),
    };
  };
  const pipeline = store.pipeline ?? [];
  const orders = store.orders ?? [];
  store.pipeline = pipeline;
  store.orders = orders;
  /** @param {Row} o */
  const describeOrder = (o) => {
    const item = pipeline.find((p) => p.id === o.pipelineItemId);
    const state = {
      status: o.status,
      supplierChosen: true,
      agreedCostMinor: o.agreedCostMinor === null ? null : Number(o.agreedCostMinor),
      currency: o.currency,
      milestones: o.milestones,
      handover: o.handover,
      pipelineStage: item?.stage ?? 'applied',
    };
    return {
      ...o,
      jobTitle: item?.jobTitle ?? 'Unknown job',
      pipelineStage: state.pipelineStage,
      milestonesTotalMinor: milestoneTotal(o.milestones).toString(),
      reconciled:
        state.agreedCostMinor !== null &&
        o.milestones.length > 0 &&
        reconcileMilestones(o.milestones, state.agreedCostMinor, o.currency).ok,
      moves: Object.fromEntries(
        (DELIVERY_TRANSITIONS[/** @type {'draft'} */ (o.status)] ?? []).map(
          (/** @type {any} */ to) => [to, transitionBlockers(/** @type {any} */ (state), to)],
        ),
      ),
    };
  };
  /** @param {Row} item @param {string} to */
  const moveStage = (item, to) => {
    if (item.stage === to) return;
    const from = item.stage;
    item.stage = to;
    item.stageChangedAt = new Date().toISOString();
    logEvent(store, 'pipeline.stage_changed', {
      subject_table: 'pipeline_items',
      subject_id: item.id,
      payload: { via: 'web', from, to },
    });
  };
  const orderIn = () => orders.find((o) => o.id === path.split('/')[3]);
  const payments = store.payments ?? [];
  store.payments = payments;
  /** @param {Row} item */
  const paymentsView = (item) => {
    const mine = payments.filter((y) => y.pipelineItemId === item.id);
    const storedRows = mine.map((y) => ({
      kind: y.kind,
      amountMinor: Number(y.amountMinor),
      currency: y.currency,
      amountZarMinor: y.amountZarMinor === null ? null : Number(y.amountZarMinor),
    }));
    const m = realisedMargin(storedRows);
    return {
      item: {
        id: item.id,
        jobTitle: item.jobTitle,
        stage: item.stage,
        valueMinor: item.valueMinor,
        currency: item.currency,
      },
      orders: orders
        .filter((o) => o.pipelineItemId === item.id && o.status !== 'cancelled')
        .map((o) => ({
          id: o.id,
          status: o.status,
          currency: o.currency,
          supplierName: o.supplierName,
          supplierCountry:
            (store.suppliers ?? []).find((x) => x.id === o.supplierId)?.countryCode ?? null,
          milestones: o.milestones,
        })),
      payments: mine,
      margin: {
        inZarMinor: m.inZarMinor.toString(),
        supplierZarMinor: m.supplierZarMinor.toString(),
        feesZarMinor: m.feesZarMinor.toString(),
        otherZarMinor: m.otherZarMinor.toString(),
        marginZarMinor: m.marginZarMinor.toString(),
        unconverted: m.unconverted.map((u) => ({ ...u, amountMinor: String(u.amountMinor) })),
      },
      paidInFull: clientPaidInFull(
        storedRows,
        item.valueMinor === null ? null : Number(item.valueMinor),
        item.currency,
      ),
    };
  };
  const posts = store.posts ?? [];
  /** @param {Row} request */
  const whoFor = (request) => {
    const b = (store.briefs ?? []).find((row) => row.id === request.briefId);
    return {
      brief: b,
      who: {
        clientHandle: request.clientHandle,
        signOffName: b?.signOff?.name ?? null,
        jobTitle: request.jobTitle,
        jobExternalId: null,
      },
    };
  };
  const postIn = (/** @type {string} */ prefix) =>
    posts.find((row) => row.id === path.slice(prefix.length).split('/')[0]);
  /** @param {Row} p */
  const describePost = (p) => ({ ...p, manual: p.platform !== 'freelancer' });
  const identityRefused = (/** @type {Row[]} */ errors) =>
    respond(422, {
      error: 'The post could identify the client. Take out what is named and save again.',
      errors,
    });
  /** @param {{ field: string, message: string }[]} errors */
  const refused = (errors) => respond(422, { error: 'the request was not accepted', errors });
  /** @param {Row} change @param {Row | null} self */
  const templateProblems = (change, self) => {
    if (change.categorySlug && !DEMO_CATEGORIES.includes(change.categorySlug))
      return [{ field: 'categorySlug', message: 'is not a service category' }];
    if (
      change.name !== undefined &&
      templatesOf(store).some((x) => x !== self && x.name === change.name)
    )
      return [{ field: 'name', message: 'is already used by another template' }];
    return [];
  };
  const suppliers = store.suppliers ?? [];
  /** @param {Row} row @param {string} action @param {string} [reason] */
  const decide = (row, action, reason) => {
    if (row.status !== 'queued') return `This bid is ${row.status}.`;
    row.status = action === 'approve' ? 'approved' : 'rejected';
    if (action === 'approve') {
      row.approved_by = USER;
      row.approved_by_name = 'Demo Owner';
      row.approved_via = 'web';
    } else {
      row.failure_reason = reason;
    }
    row.updated_at = new Date().toISOString();
    const j = store.jobs.find((x) => x.id === row.job_id);
    if (j) j.proposal_status = row.status;
    logEvent(store, action === 'approve' ? 'proposal.approved' : 'proposal.rejected', {
      subject_table: 'proposals',
      subject_id: row.id,
      payload: { via: 'web', ...(reason ? { reason } : {}) },
    });
    return null;
  };

  return {
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
    sourcing,
    describeSourcing,
    pipeline,
    orders,
    describeOrder,
    moveStage,
    orderIn,
    payments,
    paymentsView,
    posts,
    whoFor,
    postIn,
    describePost,
    identityRefused,
    refused,
    templateProblems,
    suppliers,
    decide,
  };
}

/** @typedef {ReturnType<typeof makeContext>} Context */
