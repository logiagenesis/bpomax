// @ts-check
import {
  canApprove,
  MAX_REJECTION_REASON_LENGTH,
  validateMessageDraft,
  validateProposalEdit,
} from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import { formatDateTime, formatMoney } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { confirmAction, promptText, runAction } from './lib/ui.js';

/**
 * Approvals (ARB-061, ARB-122): the bids and the replies waiting for a person, with
 * Approve, Edit and Reject per item, and in bulk for bids. Each figure is read from the row the API sends; the ZAR margin
 * is the deal-currency margin at the rate the evaluation stored (05 section 3.4).
 *
 * Approve is a confirmation: it is the action that lets a bid leave (05 section 1.3).
 */

/**
 * @typedef {object} Proposal
 * @property {string} id
 * @property {string} job_title
 * @property {string} platform
 * @property {string} status
 * @property {string} body
 * @property {string} amount_minor
 * @property {string} currency
 * @property {number} delivery_days
 * @property {unknown[]} milestones
 * @property {string | null} approved_by_name
 * @property {string | null} approved_via
 * @property {string | null} submitted_at
 * @property {string | null} failure_reason
 * @property {string} created_at
 * @property {number | null} score
 * @property {string | null} verdict
 * @property {string | null} estimate_expected_minor
 * @property {string | null} estimate_currency
 * @property {string | null} estimate_method
 * @property {string | null} margin_minor
 * @property {string | null} margin_pct
 * @property {string | null} margin_currency
 * @property {string | null} fx_rate_used
 * @property {string | null} fx_rate_at
 */

/**
 * @typedef {object} OutboundMessage
 * @property {string} id
 * @property {string} threadId
 * @property {string} externalThreadId
 * @property {string | null} clientHandle
 * @property {string | null} jobTitle
 * @property {string} body
 * @property {'queued' | 'approved' | 'sent' | 'rejected' | 'failed'} state
 * @property {string | null} approvedByName
 * @property {string | null} approvedVia
 * @property {string | null} sentAt
 * @property {string | null} failureReason
 * @property {string} createdAt
 * @property {{ body: string, sentAt: string | null } | null} lastInbound
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`approvals is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('filters'));
const stateSelect = /** @type {HTMLSelectElement} */ (byId('state'));
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const selectAll = /** @type {HTMLInputElement} */ (byId('select-all'));
const approveSelected = /** @type {HTMLButtonElement} */ (byId('approve-selected'));
const rejectSelected = /** @type {HTMLButtonElement} */ (byId('reject-selected'));
const selectedCount = byId('selected-count');
const status = byId('status');
const list = byId('list');
const empty = byId('empty');
const paused = byId('paused');

let mayApprove = false;
/** @type {Proposal[]} */
let shown = [];

const METHOD_WORDS = /** @type {Record<string, string>} */ ({
  in_house: 'in-house',
  rate_card: 'rate card',
  market_band: 'market band',
  candidate_quote: 'quote',
  ai_build: 'AI build',
});

/**
 * The margin in rand at the rate the evaluation stored. `rate` has eight decimals
 * (numeric(18, 8)); the arithmetic is on whole numbers, rounded half up.
 * @param {string} marginMinor
 * @param {string} currency
 * @param {string | null} rate
 */
function marginInZar(marginMinor, currency, rate) {
  if (currency === 'ZAR') return formatMoney(BigInt(marginMinor), 'ZAR');
  if (!rate) return 'no rate stored';
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(8, '0').slice(0, 8)}`);
  const numerator = BigInt(marginMinor) * scaled;
  const denominator = 100_000_000n;
  const half = denominator / 2n;
  const rounded =
    numerator >= 0n ? (numerator + half) / denominator : -((-numerator + half) / denominator);
  return formatMoney(rounded, 'ZAR');
}

/** @param {string} status */
function statusBadge(status) {
  const badge = document.createElement('span');
  const kind =
    status === 'queued'
      ? 'caution'
      : status === 'approved' || status === 'submitted'
        ? 'go'
        : status === 'rejected' || status === 'failed'
          ? 'skip'
          : 'neutral';
  badge.className = `badge badge--${kind}`;
  badge.textContent =
    {
      queued: 'Waiting',
      approved: 'Approved',
      submitted: 'Sent',
      rejected: 'Rejected',
      failed: 'Failed',
      draft: 'Draft',
    }[status] ?? status;
  return badge;
}

/**
 * @param {string} term
 * @param {string} value
 */
function figure(term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  return [dt, dd];
}

/** @param {Proposal} p */
function card(p) {
  const article = document.createElement('article');
  article.className = 'card stack';
  article.dataset.id = p.id;
  article.setAttribute('aria-labelledby', `bid-${p.id}-title`);

  const head = document.createElement('div');
  head.className = 'cluster';
  const pick = document.createElement('label');
  pick.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'pick';
  box.value = p.id;
  box.disabled = !mayApprove || p.status !== 'queued';
  box.setAttribute('aria-label', `Select ${p.job_title}`);
  box.addEventListener('change', syncBulk);
  pick.append(box);
  const title = document.createElement('h2');
  title.id = `bid-${p.id}-title`;
  title.textContent = p.job_title;
  head.append(pick, title, statusBadge(p.status));

  const figures = document.createElement('dl');
  figures.className = 'bid__figures';
  figures.append(
    ...figure(
      'Price',
      `${formatMoney(BigInt(p.amount_minor), p.currency)} · ${String(p.delivery_days)} days · ${String(p.milestones.length)} milestone${p.milestones.length === 1 ? '' : 's'}`,
    ),
    ...figure(
      'Score',
      p.score === null ? 'Not scored' : `${String(p.score)} (${p.verdict ?? '?'})`,
    ),
    ...figure(
      'Estimated cost',
      p.estimate_expected_minor && p.estimate_currency
        ? `${formatMoney(BigInt(p.estimate_expected_minor), p.estimate_currency)} (${METHOD_WORDS[p.estimate_method ?? ''] ?? p.estimate_method})`
        : 'No estimate stored',
    ),
    ...figure(
      'Projected margin',
      p.margin_minor && p.margin_currency && p.margin_pct
        ? `${formatMoney(BigInt(p.margin_minor), p.margin_currency)} (${p.margin_pct.replace('.', ',')}%) · ${marginInZar(p.margin_minor, p.margin_currency, p.fx_rate_used)} in rand${p.fx_rate_at && p.margin_currency !== 'ZAR' ? ` at the rate of ${formatDateTime(p.fx_rate_at)}` : ''}`
        : 'No margin stored',
    ),
    ...figure('Drafted', formatDateTime(p.created_at)),
  );
  if (p.approved_by_name) {
    figures.append(...figure('Approved by', `${p.approved_by_name} via ${p.approved_via ?? '?'}`));
  }
  if (p.failure_reason)
    figures.append(...figure(p.status === 'rejected' ? 'Reason' : 'Failure', p.failure_reason));

  const body = document.createElement('pre');
  body.className = 'bid__body';
  body.textContent = p.body;

  const editor = document.createElement('form');
  editor.className = 'stack';
  editor.hidden = true;
  editor.noValidate = true;
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.className = 'field__label';
  label.htmlFor = `body-${p.id}`;
  label.textContent = 'Bid text';
  const textarea = document.createElement('textarea');
  textarea.className = 'textarea';
  textarea.id = `body-${p.id}`;
  textarea.rows = 8;
  textarea.value = p.body;
  textarea.setAttribute('aria-describedby', `body-${p.id}-error`);
  const error = document.createElement('p');
  error.className = 'field__error';
  error.id = `body-${p.id}-error`;
  error.hidden = true;
  field.append(label, textarea, error);
  const editActions = document.createElement('div');
  editActions.className = 'row-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save text';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  editActions.append(save, cancel);
  editor.append(field, editActions);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn--primary';
  approve.textContent = 'Approve';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn--secondary';
  edit.textContent = 'Edit';
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'btn btn--danger';
  reject.textContent = 'Reject';
  for (const button of [approve, edit, reject])
    button.setAttribute('aria-label', `${button.textContent} ${p.job_title}`);

  const changeable = mayApprove && p.status !== 'submitted';
  approve.disabled = !mayApprove || p.status !== 'queued';
  edit.disabled = !changeable;
  reject.disabled = !changeable || p.status === 'rejected';
  if (!mayApprove)
    for (const button of [approve, edit, reject])
      button.title = 'Your role can view bids but not change them.';
  else if (p.status === 'submitted')
    for (const button of [approve, edit, reject]) button.title = 'This bid has been sent.';

  approve.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Approve this bid?',
      body: `${formatMoney(BigInt(p.amount_minor), p.currency)} for “${p.job_title}” will be handed to the sender. It still checks live mode and the bid allowance before anything leaves.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    const done = await runAction(
      approve,
      status,
      async () => {
        try {
          return /** @type {{ proposal: Proposal, biddingPaused: boolean }} */ (
            await apiSend('POST', `/v1/proposals/${p.id}/approve`)
          );
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      {
        success: (result) =>
          result?.biddingPaused
            ? `Approved “${p.job_title}”. Bidding is paused, so it waits for /resume.`
            : `Approved “${p.job_title}”. The sender has it.`,
      },
    );
    if (done) await reloadQuietly();
  });

  edit.addEventListener('click', () => {
    editor.hidden = false;
    body.hidden = true;
    textarea.focus();
  });
  cancel.addEventListener('click', () => {
    editor.hidden = true;
    body.hidden = false;
    textarea.value = p.body;
    error.hidden = true;
    textarea.removeAttribute('aria-invalid');
    edit.focus();
  });
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validated = validateProposalEdit({ body: textarea.value });
    if (!validated.ok) {
      const first = validated.errors[0];
      error.textContent = `${first?.message.charAt(0).toUpperCase()}${first?.message.slice(1)}.`;
      error.hidden = false;
      textarea.setAttribute('aria-invalid', 'true');
      textarea.focus();
      return;
    }
    error.hidden = true;
    textarea.removeAttribute('aria-invalid');
    const done = await runAction(
      save,
      status,
      async () => {
        try {
          return await apiSend('PATCH', `/v1/proposals/${p.id}`, { body: validated.value.text });
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success: `Saved the new text for “${p.job_title}”. It needs approval again.` },
    );
    if (done) await reloadQuietly();
  });

  reject.addEventListener('click', async () => {
    const reason = await promptText({
      title: `Reject “${p.job_title}”?`,
      label: 'Reason (kept with the bid and in the audit log)',
      confirmLabel: 'Reject',
      danger: true,
      maxLength: MAX_REJECTION_REASON_LENGTH,
    });
    if (reason === null) return;
    const done = await runAction(
      reject,
      status,
      async () => {
        try {
          return await apiSend('POST', `/v1/proposals/${p.id}/reject`, { reason });
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success: `Rejected “${p.job_title}”.` },
    );
    if (done) await reloadQuietly();
  });

  actions.append(approve, edit, reject);
  article.append(head, figures, body, editor, actions);
  return article;
}

/**
 * A reply waiting for a person (ARB-122). The same three actions as a bid, against
 * `/v1/outbound-messages`; the sender behind Approve holds the live gate.
 * @param {OutboundMessage} m
 */
function messageCard(m) {
  const handle = m.clientHandle ?? 'the client';
  const article = document.createElement('article');
  article.className = 'card stack';
  article.dataset.id = m.id;
  article.dataset.kind = 'reply';
  article.setAttribute('aria-labelledby', `reply-${m.id}-title`);

  const head = document.createElement('div');
  head.className = 'cluster';
  const title = document.createElement('h2');
  title.id = `reply-${m.id}-title`;
  title.textContent = `Reply to ${handle}`;
  head.append(title, statusBadge(m.state === 'sent' ? 'submitted' : m.state));

  const figures = document.createElement('dl');
  figures.className = 'bid__figures';
  figures.append(
    ...figure('About', m.jobTitle ?? 'No linked job'),
    ...figure(
      'Client wrote',
      m.lastInbound
        ? `${m.lastInbound.body}${m.lastInbound.sentAt ? ` (${formatDateTime(m.lastInbound.sentAt)})` : ''}`
        : 'No client message stored',
    ),
    ...figure('Drafted', formatDateTime(m.createdAt)),
  );
  if (m.approvedByName) {
    figures.append(...figure('Approved by', `${m.approvedByName} via ${m.approvedVia ?? '?'}`));
  }
  if (m.sentAt) figures.append(...figure('Sent', formatDateTime(m.sentAt)));
  if (m.failureReason)
    figures.append(...figure(m.state === 'rejected' ? 'Reason' : 'Failure', m.failureReason));

  const body = document.createElement('pre');
  body.className = 'bid__body';
  body.textContent = m.body;

  const editor = document.createElement('form');
  editor.className = 'stack';
  editor.hidden = true;
  editor.noValidate = true;
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.className = 'field__label';
  label.htmlFor = `reply-body-${m.id}`;
  label.textContent = 'Reply text';
  const textarea = document.createElement('textarea');
  textarea.className = 'textarea';
  textarea.id = `reply-body-${m.id}`;
  textarea.rows = 6;
  textarea.value = m.body;
  textarea.setAttribute('aria-describedby', `reply-body-${m.id}-error`);
  const error = document.createElement('p');
  error.className = 'field__error';
  error.id = `reply-body-${m.id}-error`;
  error.hidden = true;
  field.append(label, textarea, error);
  const editActions = document.createElement('div');
  editActions.className = 'row-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save text';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  editActions.append(save, cancel);
  editor.append(field, editActions);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn--primary';
  approve.textContent = 'Approve';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn--secondary';
  edit.textContent = 'Edit';
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'btn btn--danger';
  reject.textContent = 'Reject';
  for (const button of [approve, edit, reject])
    button.setAttribute('aria-label', `${button.textContent} reply to ${handle}`);
  const changeable = mayApprove && m.state !== 'sent';
  approve.disabled = !mayApprove || m.state !== 'queued';
  edit.disabled = !changeable;
  reject.disabled = !changeable || m.state === 'rejected';
  if (!mayApprove)
    for (const button of [approve, edit, reject])
      button.title = 'Your role can view replies but not change them.';
  else if (m.state === 'sent')
    for (const button of [approve, edit, reject]) button.title = 'This reply has been sent.';

  approve.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Approve this reply?',
      body: `The reply to “${handle}” about “${m.jobTitle ?? 'no linked job'}” will be handed to the sender. It still checks live mode before anything leaves.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    const done = await runAction(
      approve,
      status,
      async () => {
        try {
          return await apiSend('POST', `/v1/outbound-messages/${m.id}/approve`);
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success: `Approved the reply to “${handle}”. The sender has it.` },
    );
    if (done) await reloadQuietly();
  });

  edit.addEventListener('click', () => {
    editor.hidden = false;
    body.hidden = true;
    textarea.focus();
  });
  cancel.addEventListener('click', () => {
    editor.hidden = true;
    body.hidden = false;
    textarea.value = m.body;
    error.hidden = true;
    textarea.removeAttribute('aria-invalid');
    edit.focus();
  });
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validated = validateMessageDraft({ body: textarea.value });
    if (!validated.ok) {
      const first = validated.errors[0];
      error.textContent = `${first?.message.charAt(0).toUpperCase()}${first?.message.slice(1)}.`;
      error.hidden = false;
      textarea.setAttribute('aria-invalid', 'true');
      textarea.focus();
      return;
    }
    error.hidden = true;
    textarea.removeAttribute('aria-invalid');
    const done = await runAction(
      save,
      status,
      async () => {
        try {
          return await apiSend('PATCH', `/v1/outbound-messages/${m.id}`, {
            body: validated.value.text,
          });
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success: `Saved the new text for the reply to “${handle}”. It needs approval again.` },
    );
    if (done) await reloadQuietly();
  });

  reject.addEventListener('click', async () => {
    const reason = await promptText({
      title: `Reject the reply to “${handle}”?`,
      label: 'Reason (kept with the reply and in the audit log)',
      confirmLabel: 'Reject',
      danger: true,
      maxLength: MAX_REJECTION_REASON_LENGTH,
    });
    if (reason === null) return;
    const done = await runAction(
      reject,
      status,
      async () => {
        try {
          return await apiSend('POST', `/v1/outbound-messages/${m.id}/reject`, { reason });
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success: `Rejected the reply to “${handle}”.` },
    );
    if (done) await reloadQuietly();
  });

  actions.append(approve, edit, reject);
  article.append(head, figures, body, editor, actions);
  return article;
}

function selectedIds() {
  return [...list.querySelectorAll('input.pick:checked')].map(
    (box) => /** @type {HTMLInputElement} */ (box).value,
  );
}

function syncBulk() {
  const ids = selectedIds();
  const selectable = list.querySelectorAll('input.pick:not(:disabled)').length;
  approveSelected.disabled = ids.length === 0;
  rejectSelected.disabled = ids.length === 0;
  selectAll.disabled = selectable === 0;
  selectAll.checked = selectable > 0 && ids.length === selectable;
  selectedCount.textContent =
    ids.length === 0 ? 'Nothing selected.' : `${String(ids.length)} selected.`;
}

/**
 * @param {Proposal[]} proposals
 * @param {OutboundMessage[]} messages
 */
function render(proposals, messages) {
  shown = proposals;
  list.replaceChildren(...proposals.map(card), ...messages.map(messageCard));
  empty.hidden = proposals.length + messages.length !== 0;
  syncBulk();
}

/** The page's own filter words map onto the messages' states (`sent`, not `submitted`). */
const MESSAGE_STATE = /** @type {Record<string, string>} */ ({ submitted: 'sent' });

/** @param {{ bids: number, replies: number }} counts */
function loadedText(counts) {
  const bids = `${String(counts.bids)} bid${counts.bids === 1 ? '' : 's'}`;
  const replies = `${String(counts.replies)} repl${counts.replies === 1 ? 'y' : 'ies'}`;
  if (counts.bids + counts.replies === 0) {
    return stateSelect.value === 'queued' ? 'Nothing is waiting for approval.' : 'Nothing here.';
  }
  if (counts.replies === 0) return `Loaded ${bids}.`;
  if (counts.bids === 0) return `Loaded ${replies}.`;
  return `Loaded ${bids} and ${replies}.`;
}

async function fetchList() {
  const state = stateSelect.value;
  const [bids, replies] = await Promise.all([
    /** @type {Promise<{ proposals: Proposal[], biddingPaused: boolean }>} */ (
      apiGet('/v1/proposals', { status: state })
    ),
    /** @type {Promise<{ messages: OutboundMessage[] }>} */ (
      apiGet('/v1/outbound-messages', { status: MESSAGE_STATE[state] ?? state })
    ),
  ]);
  paused.hidden = !bids.biddingPaused;
  render(bids.proposals, replies.messages);
  const params = new URLSearchParams();
  if (state !== 'queued') params.set('status', state);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  return { bids: bids.proposals.length, replies: replies.messages.length };
}

/** After an action: the list is refreshed and the action's own message stays on screen. */
async function reloadQuietly() {
  try {
    await fetchList();
  } catch (error) {
    if (backToLoginOn401(error)) return;
    status.className = 'alert alert--error';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** @param {HTMLButtonElement} button */
async function load(button) {
  await runAction(
    button,
    status,
    async () => {
      try {
        return await fetchList();
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    { success: (counts) => (counts ? loadedText(counts) : '') },
  );
}

/**
 * @param {HTMLButtonElement} button
 * @param {'approve' | 'reject'} action
 * @param {string} [reason]
 */
async function bulk(button, action, reason) {
  const ids = selectedIds();
  const done = await runAction(
    button,
    status,
    async () => {
      try {
        return /** @type {{ results: { id: string, ok: boolean, error?: string }[] }} */ (
          await apiSend('POST', '/v1/proposals/bulk', { action, ids, reason })
        );
      } catch (e) {
        if (backToLoginOn401(e)) return undefined;
        throw e;
      }
    },
    {
      success: (result) => {
        const okCount = result?.results.filter((r) => r.ok).length ?? 0;
        const failed = result?.results.filter((r) => !r.ok) ?? [];
        const word = action === 'approve' ? 'Approved' : 'Rejected';
        const failures = failed
          .map(
            (r) => `${shown.find((p) => p.id === r.id)?.job_title ?? r.id}: ${r.error ?? 'failed'}`,
          )
          .join('; ');
        return `${word} ${String(okCount)} of ${String(ids.length)}.${failures ? ` Not done: ${failures}.` : ''}`;
      },
    },
  );
  if (done) await reloadQuietly();
}

approveSelected.addEventListener('click', async () => {
  const ids = selectedIds();
  const ok = await confirmAction({
    title: `Approve ${String(ids.length)} bid${ids.length === 1 ? '' : 's'}?`,
    body: 'Each one is handed to the sender, which still checks live mode and the bid allowance before anything leaves.',
    confirmLabel: 'Approve all selected',
  });
  if (ok) await bulk(approveSelected, 'approve');
});

rejectSelected.addEventListener('click', async () => {
  const ids = selectedIds();
  const reason = await promptText({
    title: `Reject ${String(ids.length)} bid${ids.length === 1 ? '' : 's'}?`,
    label: 'Reason, recorded on each bid',
    confirmLabel: 'Reject all selected',
    danger: true,
    maxLength: MAX_REJECTION_REASON_LENGTH,
  });
  if (reason !== null) await bulk(rejectSelected, 'reject', reason);
});

selectAll.addEventListener('change', () => {
  for (const box of list.querySelectorAll('input.pick:not(:disabled)')) {
    /** @type {HTMLInputElement} */ (box).checked = selectAll.checked;
  }
  syncBulk();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void load(applyButton);
});
refreshButton.addEventListener('click', () => void load(refreshButton));

const wanted = new URLSearchParams(location.search).get('status');
if (wanted && [...stateSelect.options].some((option) => option.value === wanted))
  stateSelect.value = wanted;

void mountShell().then((me) => {
  if (!me) return;
  mayApprove = canApprove(me.role);
  void load(applyButton);
});
