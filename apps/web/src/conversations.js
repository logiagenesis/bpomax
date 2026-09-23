// @ts-check
import {
  DISCOVERY_QUESTIONS,
  canWrite,
  validateBrief,
  validateDiscoveryAnswers,
  validateMessageDraft,
} from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import { formatDateTime, formatMoney } from './lib/format.js';
import {
  clearFieldErrors,
  minorToRandInput,
  parseRandToMinor,
  showFieldErrors,
} from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { confirmAction, runAction } from './lib/ui.js';

/**
 * Conversations (ARB-140, docs/01 section I: "threads, discovery progress, brief
 * builder"). The list is `GET /v1/threads`; one thread is `GET /v1/threads/:id` with its
 * messages, `GET /v1/threads/:id/discovery` and `GET /v1/threads/:id/brief`. Every
 * change goes through the route that owns it: a reply is drafted with
 * `POST /v1/threads/:id/messages` and waits in Approvals (ARB-122); discovery is
 * started, answered by hand and moved on with the ARB-130 routes; the brief is drafted,
 * edited, locked and versioned with the ARB-131 routes. Nothing here sends anything.
 */
const PAGE_SIZE = 50;

/**
 * @typedef {object} ThreadRow
 * @property {string} id
 * @property {string} platform
 * @property {string} externalThreadId
 * @property {string | null} jobId
 * @property {string | null} jobTitle
 * @property {string | null} clientHandle
 * @property {string} status
 * @property {string | null} lastMessageAt
 * @property {number} messageCount
 * @property {number} pendingReplies
 * @property {{ direction: string, body: string, sentAt: string | null } | null} lastMessage
 * @property {{ completeness: number } | null} discovery
 * @property {{ id: string, version: number, locked: boolean } | null} brief
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Message
 * @property {string} id
 * @property {'in' | 'out'} direction
 * @property {'app' | 'platform'} origin
 * @property {string} body
 * @property {string} state
 * @property {string | null} sentAt
 * @property {string | null} approvedByName
 * @property {string | null} approvedVia
 * @property {string | null} rejectedAt
 * @property {string | null} failureReason
 * @property {string} createdAt
 */

/**
 * @typedef {object} DiscoverySession
 * @property {string} id
 * @property {number} completeness
 * @property {{ key: string, text: string, answer: { answer: string, source: string, capturedAt: string } | null, askedAt: string | null }[]} questions
 * @property {string[]} nextBatch
 */

/**
 * @typedef {object} Brief
 * @property {string} id
 * @property {number} version
 * @property {boolean} locked
 * @property {string | null} lockedAt
 * @property {string} title
 * @property {string} outcome
 * @property {string | null} users
 * @property {string[]} mustHaves
 * @property {string[]} later
 * @property {string[]} references
 * @property {string[]} assetsProvided
 * @property {string[]} assetsMissing
 * @property {string[]} techConstraints
 * @property {string | null} deadline
 * @property {boolean | null} deadlineFixed
 * @property {{ minMinor: number | null, maxMinor: number | null, currency: string | null, type: string | null }} budget
 * @property {string[]} acceptanceCriteria
 * @property {{ name: string | null, responseTime: string | null }} signOff
 * @property {string[]} risks
 * @property {string | null} category
 * @property {string | null} deliveryRoute
 * @property {string[]} lockBlockers
 * @property {string} updatedAt
 */

/** @typedef {{ id: string, version: number, locked: boolean, lockedAt: string | null, updatedAt: string }} BriefVersion */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`conversations is missing #${id}`);
  return element;
}

const filters = /** @type {HTMLFormElement} */ (byId('filters'));
const statusFilter = /** @type {HTMLSelectElement} */ (byId('thread-status-filter'));
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const status = byId('status');
const results = byId('results');
const rowsBody = byId('rows');
const empty = byId('empty');

const threadSection = byId('thread');
const threadTitle = byId('thread-title');
const threadMeta = byId('thread-meta');
const threadStatus = byId('thread-status');
const messagesList = byId('messages');
const messagesEmpty = byId('messages-empty');
const replyForm = /** @type {HTMLFormElement} */ (byId('reply-form'));
const replyBody = /** @type {HTMLTextAreaElement} */ (byId('reply-body'));
const replyQueue = /** @type {HTMLButtonElement} */ (byId('reply-queue'));

const discoveryCompleteness = byId('discovery-completeness');
const discoverySummary = byId('discovery-summary');
const discoveryProgress = /** @type {HTMLProgressElement} */ (byId('discovery-progress'));
const discoveryStart = /** @type {HTMLButtonElement} */ (byId('discovery-start'));
const discoveryNext = /** @type {HTMLButtonElement} */ (byId('discovery-next'));
const discoveryForm = /** @type {HTMLFormElement} */ (byId('discovery-form'));
const discoveryQuestions = byId('discovery-questions');
const discoverySave = /** @type {HTMLButtonElement} */ (byId('discovery-save'));

const briefState = byId('brief-state');
const briefSummary = byId('brief-summary');
const briefDraft = /** @type {HTMLButtonElement} */ (byId('brief-draft'));
const briefLock = /** @type {HTMLButtonElement} */ (byId('brief-lock'));
const briefNewVersion = /** @type {HTMLButtonElement} */ (byId('brief-new-version'));
const briefVersions = byId('brief-versions');
const briefForm = /** @type {HTMLFormElement} */ (byId('brief-form'));
const briefSave = /** @type {HTMLButtonElement} */ (byId('brief-save'));
const briefCategory = /** @type {HTMLSelectElement} */ (byId('brief-category'));

let mayWrite = false;
const ROLE_REASON = 'Your role can view conversations but not change them.';

/** @type {ThreadRow | null} */
let current = null;
/** @type {DiscoverySession | null} */
let session = null;
/** @type {Brief | null} */
let brief = null;
/** @type {BriefVersion[]} */
let versions = [];
/** The version on screen when it is not the current one (read-only). @type {Brief | null} */
let shown = null;

const STATUS_WORDS = /** @type {Record<string, string>} */ ({
  open: 'Open',
  awaiting_client: 'Awaiting the client',
  awaiting_operator: 'Awaiting you',
  closed: 'Closed',
});

const STATE_WORDS = /** @type {Record<string, string>} */ ({
  received: 'From the client',
  observed: 'Sent, seen on the platform',
  queued: 'Waiting for approval',
  approved: 'Approved, sending',
  sent: 'Sent',
  rejected: 'Rejected',
  failed: 'Failed to send',
});

const SOURCE_WORDS = /** @type {Record<string, string>} */ ({
  client: 'from the client’s reply',
  operator: 'entered by hand',
});

// ------------------------------------------------------------------ helpers
/** @param {string} text @param {number} max */
function snippet(text, max) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** ISO `YYYY-MM-DD` shown as DD/MM/YYYY, without a time zone in the way. @param {string | null} iso */
function isoToInput(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/** DD/MM/YYYY typed → ISO `YYYY-MM-DD`, or null when it is not a real date. @param {string} text */
function inputToIso(text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** @param {string} text */
function lines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} reason empty when the button is usable
 */
function gate(button, reason) {
  button.disabled = reason !== '';
  if (reason) button.title = reason;
  else button.removeAttribute('title');
}

/** @param {string} kind @param {string} text */
function badge(kind, text) {
  const span = document.createElement('span');
  span.className = `badge badge--${kind}`;
  span.textContent = text;
  return span;
}

/** @param {unknown} error */
function tell(error) {
  threadStatus.className = 'alert alert--error';
  threadStatus.textContent = error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ the list
/** @param {ThreadRow[]} threads */
function renderList(threads) {
  rowsBody.replaceChildren();
  for (const t of threads) {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (current && current.id === t.id) tr.setAttribute('aria-current', 'true');
    const handle = t.clientHandle ?? 'Unnamed client';

    const client = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = handle;
    const meta = document.createElement('div');
    meta.className = 'field__hint';
    meta.textContent = `${t.platform} · thread ${t.externalThreadId}`;
    client.append(strong, meta);

    const about = document.createElement('td');
    about.textContent = t.jobTitle ?? 'No linked job';

    const state = document.createElement('td');
    state.textContent = STATUS_WORDS[t.status] ?? t.status;

    const last = document.createElement('td');
    if (t.lastMessage) {
      const when = document.createElement('div');
      when.textContent = formatDateTime(t.lastMessage.sentAt ?? t.lastMessageAt ?? t.updatedAt);
      const text = document.createElement('div');
      text.className = 'field__hint';
      text.textContent = `${t.lastMessage.direction === 'in' ? 'Client' : 'You'}: ${snippet(t.lastMessage.body, 80)}`;
      last.append(when, text);
    } else {
      last.textContent = 'No messages yet';
    }

    const discovery = document.createElement('td');
    discovery.className = 'num';
    discovery.textContent = t.discovery ? `${String(t.discovery.completeness)} %` : 'Not started';

    const briefCell = document.createElement('td');
    briefCell.textContent = t.brief
      ? `Version ${String(t.brief.version)}, ${t.brief.locked ? 'locked' : 'open'}`
      : 'None';

    const waiting = document.createElement('td');
    waiting.className = 'num';
    waiting.textContent =
      t.pendingReplies === 0
        ? '—'
        : `${String(t.pendingReplies)} repl${t.pendingReplies === 1 ? 'y' : 'ies'}`;

    const action = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn--primary';
    open.textContent = 'Open';
    open.setAttribute('aria-label', `Open the conversation with ${handle}`);
    open.addEventListener('click', () => void openThread(open, t.id));
    action.append(open);

    tr.append(client, about, state, last, discovery, briefCell, waiting, action);
    rowsBody.append(tr);
  }
  results.hidden = threads.length === 0;
  empty.hidden = threads.length !== 0;
}

function reflectInUrl() {
  const params = new URLSearchParams();
  if (statusFilter.value) params.set('status', statusFilter.value);
  if (current) params.set('thread', current.id);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

async function fetchList() {
  const body = await apiGet('/v1/threads', {
    status: statusFilter.value || undefined,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const threads = /** @type {{ threads: ThreadRow[] }} */ (body).threads;
  renderList(threads);
  reflectInUrl();
  return threads.length;
}

/** @param {HTMLButtonElement} button */
async function fetchAndRender(button) {
  await runAction(
    button,
    status,
    async () => {
      try {
        return await fetchList();
      } catch (error) {
        if (backToLoginOn401(error)) return 0;
        throw error;
      }
    },
    {
      success: (n) =>
        n === 0
          ? 'No conversations match this filter.'
          : `Loaded ${String(n)} conversation${n === 1 ? '' : 's'}.`,
    },
  );
}

// ---------------------------------------------------------------- one thread
/** @param {Message[]} messages */
function renderMessages(messages) {
  messagesList.replaceChildren();
  for (const m of messages) {
    const li = document.createElement('li');
    li.className = 'card stack';
    li.dataset.state = m.state;
    li.dataset.direction = m.direction;
    const head = document.createElement('div');
    head.className = 'cluster';
    head.append(
      badge(
        m.direction === 'in'
          ? 'neutral'
          : m.state === 'sent' || m.state === 'observed'
            ? 'go'
            : m.state === 'rejected' || m.state === 'failed'
              ? 'skip'
              : 'caution',
        STATE_WORDS[m.state] ?? m.state,
      ),
    );
    const when = document.createElement('span');
    when.className = 'field__hint';
    when.textContent = formatDateTime(m.sentAt ?? m.createdAt);
    head.append(when);
    if (m.approvedByName) {
      const who = document.createElement('span');
      who.className = 'field__hint';
      who.textContent = `approved by ${m.approvedByName} via ${m.approvedVia ?? '?'}`;
      head.append(who);
    }
    if (m.failureReason) {
      const why = document.createElement('span');
      why.className = 'field__hint';
      why.textContent = `${m.state === 'rejected' ? 'reason' : 'failure'}: ${m.failureReason}`;
      head.append(why);
    }
    const body = document.createElement('pre');
    body.className = 'bid__body';
    body.textContent = m.body;
    li.append(head, body);
    messagesList.append(li);
  }
  messagesEmpty.hidden = messages.length !== 0;
  gate(replyQueue, mayWrite ? '' : ROLE_REASON);
  replyBody.readOnly = !mayWrite;
}

function renderDiscovery() {
  const answered = session ? session.questions.filter((q) => q.answer !== null).length : 0;
  const total = DISCOVERY_QUESTIONS.length;
  if (!session) {
    discoveryCompleteness.textContent = 'Not started';
    discoverySummary.textContent =
      'Discovery has not started. Starting it drafts the first three questions as a reply, which waits for approval in Approvals.';
    discoveryProgress.value = 0;
    discoveryForm.hidden = true;
    gate(discoveryStart, mayWrite ? '' : ROLE_REASON);
    gate(discoveryNext, mayWrite ? 'Start discovery first.' : ROLE_REASON);
    gate(discoverySave, mayWrite ? 'Start discovery first.' : ROLE_REASON);
    return;
  }
  discoveryCompleteness.textContent = `${String(session.completeness)} %`;
  discoveryProgress.value = session.completeness;
  discoverySummary.textContent =
    session.completeness >= 100
      ? `Every one of the ${String(total)} questions is answered.`
      : `${String(answered)} of ${String(total)} questions answered. The next batch is ${session.nextBatch.length === 0 ? 'empty' : `${String(session.nextBatch.length)} question${session.nextBatch.length === 1 ? '' : 's'}`}; each batch is drafted as a reply and waits for approval in Approvals.`;
  discoveryQuestions.replaceChildren();
  for (const q of session.questions) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'field__label';
    label.htmlFor = `discovery-answers-${q.key}`;
    label.textContent = q.text;
    const textarea = document.createElement('textarea');
    textarea.className = 'textarea';
    textarea.id = `discovery-answers-${q.key}`;
    textarea.name = q.key;
    textarea.rows = 2;
    textarea.maxLength = 2000;
    textarea.value = q.answer?.answer ?? '';
    textarea.readOnly = !mayWrite;
    textarea.setAttribute(
      'aria-describedby',
      `discovery-answers-${q.key}-hint discovery-answers-${q.key}-error`,
    );
    const hint = document.createElement('p');
    hint.className = 'field__hint';
    hint.id = `discovery-answers-${q.key}-hint`;
    hint.textContent = q.answer
      ? `Answered ${SOURCE_WORDS[q.answer.source] ?? q.answer.source} on ${formatDateTime(q.answer.capturedAt)}.`
      : q.askedAt
        ? `Asked on ${formatDateTime(q.askedAt)}; no answer yet.`
        : 'Not asked yet.';
    const error = document.createElement('p');
    error.className = 'field__error';
    error.id = `discovery-answers-${q.key}-error`;
    error.hidden = true;
    field.append(label, textarea, hint, error);
    discoveryQuestions.append(field);
  }
  discoveryForm.hidden = false;
  gate(discoveryStart, mayWrite ? 'Discovery has already started on this thread.' : ROLE_REASON);
  gate(
    discoveryNext,
    !mayWrite
      ? ROLE_REASON
      : session.nextBatch.length === 0
        ? 'Every question has been answered; there is nothing left to ask.'
        : '',
  );
  gate(discoverySave, mayWrite ? '' : ROLE_REASON);
}

/** @param {Brief} b */
function fillBriefForm(b) {
  const set = (/** @type {string} */ id, /** @type {string} */ value) => {
    const element = /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} */ (
      byId(id)
    );
    element.value = value;
  };
  set('brief-title', b.title);
  set('brief-category', b.category ?? '');
  set('brief-deliveryRoute', b.deliveryRoute ?? '');
  set('brief-outcome', b.outcome);
  set('brief-users', b.users ?? '');
  set('brief-mustHaves', b.mustHaves.join('\n'));
  set('brief-later', b.later.join('\n'));
  set('brief-acceptanceCriteria', b.acceptanceCriteria.join('\n'));
  set('brief-references', b.references.join('\n'));
  set('brief-assetsProvided', b.assetsProvided.join('\n'));
  set('brief-assetsMissing', b.assetsMissing.join('\n'));
  set('brief-techConstraints', b.techConstraints.join('\n'));
  set('brief-risks', b.risks.join('\n'));
  set('brief-deadline', isoToInput(b.deadline));
  set('brief-deadlineFixed', b.deadlineFixed === null ? '' : String(b.deadlineFixed));
  set('brief-budget-currency', b.budget.currency ?? '');
  set(
    'brief-budget-minMinor',
    b.budget.minMinor === null ? '' : minorToRandInput(b.budget.minMinor),
  );
  set(
    'brief-budget-maxMinor',
    b.budget.maxMinor === null ? '' : minorToRandInput(b.budget.maxMinor),
  );
  set('brief-budget-type', b.budget.type ?? '');
  set('brief-signOff-name', b.signOff.name ?? '');
  set('brief-signOff-responseTime', b.signOff.responseTime ?? '');
}

/** The form as the API reads it (`validateBrief`), from what is typed. Money never becomes a float. */
function readBriefForm() {
  const get = (/** @type {string} */ id) =>
    /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} */ (byId(id)).value;
  /** @type {{ field: string, message: string }[]} */
  const errors = [];
  const deadlineText = get('brief-deadline').trim();
  const deadline = deadlineText ? inputToIso(deadlineText) : null;
  if (deadlineText && !deadline)
    errors.push({ field: 'deadline', message: 'must be a date as DD/MM/YYYY' });
  const minText = get('brief-budget-minMinor').trim();
  const maxText = get('brief-budget-maxMinor').trim();
  const minMinor = minText ? parseRandToMinor(minText) : null;
  const maxMinor = maxText ? parseRandToMinor(maxText) : null;
  if (minText && minMinor === null)
    errors.push({ field: 'budget.minMinor', message: 'must be an amount such as 1 500,00' });
  if (maxText && maxMinor === null)
    errors.push({ field: 'budget.maxMinor', message: 'must be an amount such as 2 000,00' });
  const fixed = get('brief-deadlineFixed');
  const currency = get('brief-budget-currency').trim().toUpperCase();
  const payload = {
    title: get('brief-title').trim(),
    outcome: get('brief-outcome').trim(),
    users: get('brief-users').trim() || null,
    mustHaves: lines(get('brief-mustHaves')),
    later: lines(get('brief-later')),
    references: lines(get('brief-references')),
    assetsProvided: lines(get('brief-assetsProvided')),
    assetsMissing: lines(get('brief-assetsMissing')),
    techConstraints: lines(get('brief-techConstraints')),
    deadline,
    deadlineFixed: fixed === '' ? null : fixed === 'true',
    budget: {
      minMinor: minMinor === null ? null : Number(minMinor),
      maxMinor: maxMinor === null ? null : Number(maxMinor),
      currency: currency || null,
      type: get('brief-budget-type') || null,
    },
    acceptanceCriteria: lines(get('brief-acceptanceCriteria')),
    signOff: {
      name: get('brief-signOff-name').trim() || null,
      responseTime: get('brief-signOff-responseTime').trim() || null,
    },
    risks: lines(get('brief-risks')),
    category: get('brief-category') || null,
    deliveryRoute: get('brief-deliveryRoute') || null,
  };
  return { payload, errors };
}

/** @param {string[]} blockers */
function blockersSentence(blockers) {
  if (blockers.length === 0) return 'It has everything a lock needs.';
  const list =
    blockers.length === 1
      ? blockers[0]
      : `${blockers.slice(0, -1).join(', ')} and ${blockers[blockers.length - 1]}`;
  return `To lock it, it still needs ${list}.`;
}

function renderBrief() {
  const onScreen = shown ?? brief;
  briefVersions.replaceChildren();
  for (const v of versions) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost';
    button.textContent = `Show version ${String(v.version)}`;
    button.setAttribute('aria-label', `Show version ${String(v.version)} of the brief`);
    gate(button, onScreen && onScreen.id === v.id ? 'This version is on screen.' : '');
    button.addEventListener('click', () => void showVersion(button, v));
    li.append(
      button,
      ` ${v.locked ? `locked ${v.lockedAt ? formatDateTime(v.lockedAt) : ''}`.trim() : 'open'}`,
    );
    briefVersions.append(li);
  }
  if (!onScreen) {
    briefState.textContent = 'None';
    briefSummary.textContent =
      'No brief yet. Drafting one fills version 1 from the discovery answers; the rest is filled in here.';
    briefForm.hidden = true;
    gate(briefDraft, mayWrite ? '' : ROLE_REASON);
    gate(briefLock, mayWrite ? 'Draft the brief first.' : ROLE_REASON);
    gate(briefNewVersion, mayWrite ? 'Draft the brief first.' : ROLE_REASON);
    gate(briefSave, mayWrite ? 'Draft the brief first.' : ROLE_REASON);
    return;
  }
  const isCurrent = brief !== null && onScreen.id === brief.id;
  briefState.textContent = `Version ${String(onScreen.version)}, ${onScreen.locked ? 'locked' : 'open'}`;
  briefSummary.textContent = onScreen.locked
    ? `Version ${String(onScreen.version)} was locked on ${onScreen.lockedAt ? formatDateTime(onScreen.lockedAt) : 'an unknown date'} and cannot be changed. A change starts a new version.${isCurrent ? '' : ` The current version is ${String(brief?.version ?? '?')}.`}`
    : `Version ${String(onScreen.version)} is open. ${blockersSentence(onScreen.lockBlockers)}${
        onScreen.budget.minMinor !== null && onScreen.budget.currency
          ? ` Budget from ${formatMoney(onScreen.budget.minMinor, onScreen.budget.currency)}${onScreen.budget.maxMinor !== null ? ` to ${formatMoney(onScreen.budget.maxMinor, onScreen.budget.currency)}` : ''}.`
          : ''
      }`;
  fillBriefForm(onScreen);
  clearFieldErrors(briefForm);
  const readOnly = !mayWrite || onScreen.locked || !isCurrent;
  for (const element of briefForm.querySelectorAll('input, textarea, select')) {
    if (element instanceof HTMLSelectElement) element.disabled = readOnly;
    else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      element.readOnly = readOnly;
  }
  briefForm.hidden = false;
  gate(briefDraft, mayWrite ? 'This thread already has a brief.' : ROLE_REASON);
  gate(
    briefSave,
    !mayWrite
      ? ROLE_REASON
      : !isCurrent
        ? `Version ${String(onScreen.version)} is not the current one. Show version ${String(brief?.version ?? '?')} to change the brief.`
        : onScreen.locked
          ? `Version ${String(onScreen.version)} is locked. Start a new version to change it.`
          : '',
  );
  gate(
    briefLock,
    !mayWrite
      ? ROLE_REASON
      : !isCurrent
        ? `Only the current version, ${String(brief?.version ?? '?')}, can be locked.`
        : onScreen.locked
          ? `Version ${String(onScreen.version)} is already locked.`
          : '',
  );
  gate(
    briefNewVersion,
    !mayWrite
      ? ROLE_REASON
      : brief && !brief.locked
        ? `Version ${String(brief.version)} is still open. Lock it before starting another.`
        : '',
  );
}

/** @param {string} id */
async function loadThread(id) {
  const detail = /** @type {{ thread: ThreadRow, messages: Message[] }} */ (
    await apiGet(`/v1/threads/${id}`)
  );
  const [discovery, briefBody] = await Promise.all([
    /** @type {Promise<{ session: DiscoverySession | null }>} */ (
      apiGet(`/v1/threads/${id}/discovery`)
    ),
    /** @type {Promise<{ brief: Brief | null, versions: BriefVersion[] }>} */ (
      apiGet(`/v1/threads/${id}/brief`)
    ),
  ]);
  current = detail.thread;
  session = discovery.session;
  brief = briefBody.brief;
  versions = briefBody.versions;
  shown = null;
  const handle = current.clientHandle ?? 'Unnamed client';
  threadTitle.textContent = `Conversation with ${handle}`;
  threadMeta.textContent = [
    current.jobTitle ? `About ${current.jobTitle}` : 'No linked job',
    STATUS_WORDS[current.status] ?? current.status,
    `${current.platform} thread ${current.externalThreadId}`,
  ].join(' · ');
  renderMessages(detail.messages);
  renderDiscovery();
  renderBrief();
  threadSection.hidden = false;
  for (const tr of rowsBody.querySelectorAll('tr')) {
    if (tr.dataset.id === id) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
  reflectInUrl();
  return current;
}

/** After a change: the thread is read again and the message written by the action stays. */
async function reloadQuietly() {
  if (!current) return;
  try {
    await loadThread(current.id);
    await fetchList();
  } catch (error) {
    if (backToLoginOn401(error)) return;
    tell(error);
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} id
 */
async function openThread(button, id) {
  await runAction(
    button,
    threadStatus,
    async () => {
      try {
        return await loadThread(id);
      } catch (error) {
        if (backToLoginOn401(error)) return null;
        throw error;
      }
    },
    {
      success: (thread) =>
        thread ? `Opened the conversation with ${thread.clientHandle ?? 'the client'}.` : '',
    },
  );
  threadSection.scrollIntoView({ block: 'start' });
}

/**
 * @template T
 * @param {HTMLButtonElement} button
 * @param {() => Promise<T>} work
 * @param {(result: T) => string} success
 */
async function change(button, work, success) {
  const outcome = await runAction(
    button,
    threadStatus,
    async () => {
      try {
        return await work();
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    { success: (result) => (result === undefined ? '' : success(result)) },
  );
  if (outcome !== undefined) await reloadQuietly();
  return outcome;
}

// ---------------------------------------------------------------- actions
replyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!current) return;
  clearFieldErrors(replyForm);
  const validated = validateMessageDraft({ body: replyBody.value });
  if (!validated.ok) {
    showFieldErrors(replyForm, validated.errors, 'reply-');
    return;
  }
  const thread = current;
  void change(
    replyQueue,
    async () => {
      try {
        const body = /** @type {{ message: { id: string } }} */ (
          await apiSend('POST', `/v1/threads/${thread.id}/messages`, { body: validated.value.text })
        );
        replyBody.value = '';
        return body.message;
      } catch (error) {
        if (error && typeof error === 'object' && 'errors' in error) {
          const errors = /** @type {{ errors: { field: string, message: string }[] }} */ (error)
            .errors;
          if (errors.length > 0) showFieldErrors(replyForm, errors, 'reply-');
        }
        throw error;
      }
    },
    () =>
      `Your reply to ${thread.clientHandle ?? 'the client'} is waiting for approval in Approvals.`,
  );
});

discoveryStart.addEventListener('click', () => {
  if (!current) return;
  const thread = current;
  void change(
    discoveryStart,
    () =>
      /** @type {Promise<{ session: DiscoverySession, draft: { keys: string[] } | null }>} */ (
        apiSend('POST', `/v1/threads/${thread.id}/discovery`)
      ),
    (result) =>
      result.draft
        ? `Discovery started. The first ${String(result.draft.keys.length)} questions are drafted as a reply and wait for approval in Approvals.`
        : 'Discovery started.',
  );
});

discoveryNext.addEventListener('click', () => {
  if (!current) return;
  const thread = current;
  void change(
    discoveryNext,
    () =>
      /** @type {Promise<{ session: DiscoverySession, draft: { keys: string[] } }>} */ (
        apiSend('POST', `/v1/threads/${thread.id}/discovery/next`)
      ),
    (result) =>
      `The next ${String(result.draft.keys.length)} question${result.draft.keys.length === 1 ? '' : 's'} ${result.draft.keys.length === 1 ? 'is' : 'are'} drafted as a reply and wait${result.draft.keys.length === 1 ? 's' : ''} for approval in Approvals.`,
  );
});

discoveryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!current || !session) return;
  clearFieldErrors(discoveryForm);
  /** @type {Record<string, string>} */
  const answers = {};
  for (const q of session.questions) {
    const textarea = /** @type {HTMLTextAreaElement} */ (byId(`discovery-answers-${q.key}`));
    const typed = textarea.value.trim();
    if (typed && typed !== (q.answer?.answer ?? '')) answers[q.key] = typed;
  }
  if (Object.keys(answers).length === 0) {
    threadStatus.className = 'alert alert--info';
    threadStatus.textContent = 'Nothing changed: type or change an answer, then save.';
    return;
  }
  const validated = validateDiscoveryAnswers({ answers });
  if (!validated.ok) {
    showFieldErrors(discoveryForm, validated.errors, 'discovery-');
    return;
  }
  const thread = current;
  const count = Object.keys(validated.value).length;
  void change(
    discoverySave,
    async () => {
      try {
        return /** @type {{ session: DiscoverySession }} */ (
          await apiSend('PATCH', `/v1/threads/${thread.id}/discovery/answers`, {
            answers: validated.value,
          })
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'errors' in error) {
          const errors = /** @type {{ errors: { field: string, message: string }[] }} */ (error)
            .errors;
          if (errors.length > 0) showFieldErrors(discoveryForm, errors, 'discovery-');
        }
        throw error;
      }
    },
    (result) =>
      `Saved ${String(count)} answer${count === 1 ? '' : 's'}. Completeness is ${String(result.session.completeness)} %.`,
  );
});

briefDraft.addEventListener('click', () => {
  if (!current) return;
  const thread = current;
  void change(
    briefDraft,
    () =>
      /** @type {Promise<{ brief: Brief }>} */ (apiSend('POST', `/v1/threads/${thread.id}/brief`)),
    (result) =>
      `Drafted version ${String(result.brief.version)} of the brief from the discovery answers. ${blockersSentence(result.brief.lockBlockers)}`,
  );
});

briefForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!brief || shown) return;
  clearFieldErrors(briefForm);
  const { payload, errors } = readBriefForm();
  const validated = validateBrief(payload);
  const problems = [...errors, ...(validated.ok ? [] : validated.errors)];
  if (problems.length > 0) {
    showFieldErrors(briefForm, problems, 'brief-');
    return;
  }
  const id = brief.id;
  void change(
    briefSave,
    async () => {
      try {
        return /** @type {{ brief: Brief }} */ (await apiSend('PUT', `/v1/briefs/${id}`, payload));
      } catch (error) {
        if (error && typeof error === 'object' && 'errors' in error) {
          const errors = /** @type {{ errors: { field: string, message: string }[] }} */ (error)
            .errors;
          if (errors.length > 0) showFieldErrors(briefForm, errors, 'brief-');
        }
        throw error;
      }
    },
    (result) =>
      `Saved version ${String(result.brief.version)} of the brief. ${blockersSentence(result.brief.lockBlockers)}`,
  );
});

briefLock.addEventListener('click', async () => {
  if (!brief || shown) return;
  const target = brief;
  const confirmed = await confirmAction({
    title: `Lock version ${String(target.version)} of the brief?`,
    body: 'A locked version cannot be changed. A change after this starts a new version, and every version is kept.',
    confirmLabel: 'Lock',
  });
  if (!confirmed) return;
  void change(
    briefLock,
    async () => {
      try {
        return /** @type {{ brief: Brief }} */ (
          await apiSend('POST', `/v1/briefs/${target.id}/lock`)
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'errors' in error) {
          const errors = /** @type {{ errors: { field: string, message: string }[] }} */ (error)
            .errors;
          const slot = byId('brief-lock-error');
          if (errors.length > 0) {
            slot.textContent = errors.map((e) => e.message).join('; ') + '.';
            slot.hidden = false;
            // The API's own sentence, rebuilt from its list: what is missing, in words.
            throw new Error(
              `The brief cannot lock without ${errors.map((e) => e.message.replace(/^needs /, '')).join(', ')}.`,
            );
          }
        }
        throw error;
      }
    },
    (result) =>
      `Locked version ${String(result.brief.version)} of the brief${result.brief.lockedAt ? ` on ${formatDateTime(result.brief.lockedAt)}` : ''}.`,
  );
});

briefNewVersion.addEventListener('click', () => {
  if (!brief) return;
  const from = brief;
  void change(
    briefNewVersion,
    () =>
      /** @type {Promise<{ brief: Brief }>} */ (apiSend('POST', `/v1/briefs/${from.id}/versions`)),
    (result) =>
      `Started version ${String(result.brief.version)} of the brief from version ${String(from.version)}.`,
  );
});

/**
 * @param {HTMLButtonElement} button
 * @param {BriefVersion} v
 */
async function showVersion(button, v) {
  await runAction(
    button,
    threadStatus,
    async () => {
      try {
        const body = /** @type {{ brief: Brief }} */ (await apiGet(`/v1/briefs/${v.id}`));
        shown = brief && body.brief.id === brief.id ? null : body.brief;
        renderBrief();
        return body.brief;
      } catch (error) {
        if (backToLoginOn401(error)) return null;
        throw error;
      }
    },
    {
      success: (b) =>
        b ? `Showing version ${String(b.version)} of the brief${b.locked ? ', locked' : ''}.` : '',
    },
  );
}

async function loadCategories() {
  try {
    const body = /** @type {{ categories: { slug: string, name: string }[] }} */ (
      await apiGet('/v1/service-categories')
    );
    for (const c of body.categories) {
      const option = document.createElement('option');
      option.value = c.slug;
      option.textContent = c.name;
      briefCategory.append(option);
    }
  } catch (error) {
    if (backToLoginOn401(error)) return;
    tell(error);
  }
}

// ---------------------------------------------------------------- the list's controls
filters.addEventListener('submit', (event) => {
  event.preventDefault();
  void fetchAndRender(applyButton);
});
refreshButton.addEventListener('click', () => void fetchAndRender(refreshButton));

const params = new URLSearchParams(location.search);
if (params.get('status')) statusFilter.value = params.get('status') ?? '';
const linked = params.get('thread');

void mountShell().then(async (me) => {
  if (!me) return;
  mayWrite = canWrite(me.role);
  await loadCategories();
  if (linked) {
    try {
      await loadThread(linked);
      threadStatus.className = 'alert alert--success';
      threadStatus.textContent = `Opened the conversation with ${current?.clientHandle ?? 'the client'}.`;
    } catch (error) {
      if (backToLoginOn401(error)) return;
      tell(error);
    }
  }
  void fetchAndRender(applyButton);
});
