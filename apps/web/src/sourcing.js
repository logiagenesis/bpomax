// @ts-check
import { canApprove, canWrite } from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import { formatDateTime, formatMoney, formatPercent } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';
import { loadPosts, setPostRoles } from './sourcing-posts.js';

/**
 * Sourcing (ARB-201, docs/01 section I: "sourcing (requests, posts, candidates,
 * shortlist, choose supplier)"). The list is `GET /v1/sourcing-requests`; one request is
 * `GET /v1/sourcing-requests/:id` with its ranked candidates, the score's parts and the
 * reason for each, and the suppliers left out with why; the shortlist is
 * `PATCH /v1/sourcing-requests/:id/candidates/:candidateId`. A request starts from a
 * locked brief on the conversations page. Posts and the marketplace half are ARB-202
 * and ARB-203; nothing here leaves the database. Reprice (ARB-204) asks the worker to
 * judge the bid's margin with a candidate's quote as the supplier cost.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string | null} supplierId
 * @property {string} name
 * @property {string | null} channel
 * @property {string | null} countryCode
 * @property {string | null} timeZone
 * @property {string | null} currency
 * @property {string | null} quotedPriceMinor
 * @property {'fixed' | 'hourly'} priced
 * @property {number | null} turnaroundDays
 * @property {number | null} score
 * @property {{ rate: number, turnaround: number, quality: number, timeZone: number, paysAfterDelivery: number } | null} parts
 * @property {string[]} reasons
 * @property {boolean} shortlisted
 * @property {'ranking' | 'bid'} [source]
 * @property {{ evaluationId: string, currency: string | null, marginMinor: string | null, marginPct: string | null, passed: boolean | null, reason: string | null, at: string | null } | null} [margin]
 * @property {{ outcome: string, reason: string | null, message: string | null, detail: string[], at: string | null } | null} [reprice]
 */

/**
 * @typedef {object} SourcingRequest
 * @property {string} id
 * @property {string} briefId
 * @property {number} briefVersion
 * @property {string} briefTitle
 * @property {string | null} category
 * @property {string | null} deliveryRoute
 * @property {string} threadId
 * @property {string | null} clientHandle
 * @property {string | null} jobTitle
 * @property {string[]} channels
 * @property {string} status
 * @property {number} candidateCount
 * @property {number} shortlistedCount
 * @property {{ supplierId: string, name: string, reason: string }[]} excluded
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Candidate[]} [candidates]
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`sourcing is missing #${id}`);
  return element;
}

const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const status = byId('status');
const results = byId('results');
const rowsBody = byId('rows');
const empty = byId('empty');
const section = byId('request');
const title = byId('request-title');
const meta = byId('request-meta');
const requestStatus = byId('request-status');
const candidateRows = byId('candidate-rows');
const candidatesEmpty = byId('candidates-empty');
const excludedList = byId('excluded');
const excludedEmpty = byId('excluded-empty');

let mayWrite = false;
const ROLE_REASON = 'Your role can view sourcing but not change it.';
/** @type {SourcingRequest | null} */
let current = null;

const STATUS_WORDS = /** @type {Record<string, string>} */ ({
  open: 'Open',
  shortlisting: 'Shortlisting',
  chosen: 'Supplier chosen',
  closed: 'Closed',
  abandoned: 'Abandoned',
});

const ROUTE_WORDS = /** @type {Record<string, string>} */ ({
  in_house: 'in-house',
  ai_build: 'AI build',
  supplier: 'an existing supplier',
  source_new: 'a new supplier',
});

const CHANNEL_WORDS = /** @type {Record<string, string>} */ ({
  freelancer: 'Freelancer.com',
  upwork: 'Upwork',
  fiverr: 'Fiverr',
  direct: 'Direct',
  in_house: 'In-house',
  ai_build: 'AI build',
});

/** @param {Candidate} c */
function rateText(c) {
  if (c.quotedPriceMinor === null || c.currency === null) return 'No rate';
  return `${formatMoney(BigInt(c.quotedPriceMinor), c.currency)}${c.priced === 'hourly' ? ' an hour' : ' fixed'}`;
}

/** Why a reprice judged nothing (the margin worker's block reasons, D-029). */
const BLOCK_WORDS = /** @type {Record<string, string>} */ ({
  rules_missing: 'a margin rule is not set',
  fee_table_invalid: 'the fee table is not valid',
  fee_rule_missing: 'the fee table has no rule for this job',
  fx_unavailable: 'no exchange rate is available',
  currency_mismatch: 'the quote and the job are in different currencies',
});

/**
 * The bid's margin with this candidate's quote as the supplier cost, or why there is none.
 * @param {Candidate} c
 * @returns {{ text: string, hint: string, tone: 'ok' | 'bad' | 'none' }}
 */
function marginText(c) {
  const m = c.margin;
  const last = c.reprice;
  if (last && last.outcome === 'blocked')
    return {
      text: `Not priced: ${BLOCK_WORDS[last.reason ?? ''] ?? last.reason ?? 'blocked'}`,
      hint: last.detail.join('; '),
      tone: 'none',
    };
  if (last && last.outcome === 'skipped' && !m)
    return { text: 'Not priced', hint: last.message ?? '', tone: 'none' };
  if (m && m.marginMinor !== null && m.currency && m.marginPct !== null)
    return {
      text: `${formatMoney(BigInt(m.marginMinor), m.currency)} (${formatPercent(Number(m.marginPct) / 100)})`,
      hint: m.passed ? 'Clears the margin rule.' : 'Below the margin rule.',
      tone: m.passed ? 'ok' : 'bad',
    };
  return { text: 'Not priced yet', hint: '', tone: 'none' };
}

/** @param {number | null} score */
function scoreBadge(score) {
  const badge = document.createElement('span');
  const n = score ?? 0;
  badge.className = `badge badge--${n >= 70 ? 'go' : n >= 40 ? 'caution' : 'skip'}`;
  badge.textContent = score === null ? 'Not scored' : `${String(score)} / 100`;
  return badge;
}

/** @param {SourcingRequest[]} requests */
function renderList(requests) {
  rowsBody.replaceChildren();
  for (const r of requests) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if (current && current.id === r.id) tr.setAttribute('aria-current', 'true');

    const brief = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = r.briefTitle;
    const hint = document.createElement('div');
    hint.className = 'field__hint';
    hint.textContent = `${r.clientHandle ?? 'Unnamed client'} · version ${String(r.briefVersion)}`;
    brief.append(strong, hint);

    const category = document.createElement('td');
    category.textContent = r.category ?? '—';

    const state = document.createElement('td');
    state.textContent = STATUS_WORDS[r.status] ?? r.status;

    const candidates = document.createElement('td');
    candidates.className = 'num';
    candidates.textContent = `${String(r.candidateCount)} ranked, ${String(r.shortlistedCount)} shortlisted`;

    const started = document.createElement('td');
    started.textContent = formatDateTime(r.createdAt);

    const action = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn--primary';
    open.textContent = 'Open';
    open.setAttribute('aria-label', `Open the sourcing request for ${r.briefTitle}`);
    open.addEventListener('click', () => void openRequest(open, r.id));
    action.append(open);

    tr.append(brief, category, state, candidates, started, action);
    rowsBody.append(tr);
  }
  results.hidden = requests.length === 0;
  empty.hidden = requests.length !== 0;
}

/** @param {SourcingRequest} r */
function renderRequest(r) {
  current = r;
  title.textContent = `Sourcing for ${r.briefTitle}`;
  meta.textContent = [
    r.clientHandle ? `Client ${r.clientHandle}` : 'No client handle',
    r.category ? `category ${r.category}` : 'no category',
    r.deliveryRoute ? `route ${ROUTE_WORDS[r.deliveryRoute] ?? r.deliveryRoute}` : null,
    STATUS_WORDS[r.status] ?? r.status,
    `started ${formatDateTime(r.createdAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  candidateRows.replaceChildren();
  const candidates = r.candidates ?? [];
  candidates.forEach((c, index) => {
    const tr = document.createElement('tr');
    tr.dataset.id = c.id;
    if (c.shortlisted) tr.dataset.shortlisted = 'true';

    const rank = document.createElement('td');
    rank.className = 'num';
    rank.textContent = String(index + 1);

    const who = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = c.name;
    const hint = document.createElement('div');
    hint.className = 'field__hint';
    hint.textContent = [
      c.channel ? (CHANNEL_WORDS[c.channel] ?? c.channel) : null,
      c.countryCode,
      c.timeZone,
    ]
      .filter(Boolean)
      .join(' · ');
    who.append(strong, hint);

    const rate = document.createElement('td');
    rate.className = 'num';
    rate.textContent = rateText(c);

    const turnaround = document.createElement('td');
    turnaround.className = 'num';
    turnaround.textContent =
      c.turnaroundDays === null
        ? 'Not recorded'
        : `${String(c.turnaroundDays)} day${c.turnaroundDays === 1 ? '' : 's'}`;

    const score = document.createElement('td');
    score.append(scoreBadge(c.score));
    if (c.parts) {
      const parts = document.createElement('div');
      parts.className = 'field__hint';
      parts.textContent = `rate ${String(c.parts.rate)}, turnaround ${String(c.parts.turnaround)}, quality ${String(c.parts.quality)}, time zone ${String(c.parts.timeZone)}, payment ${String(c.parts.paysAfterDelivery)}`;
      score.append(parts);
    }

    const why = document.createElement('td');
    const list = document.createElement('ul');
    list.className = 'stack';
    const reasons =
      c.source === 'bid' && c.reasons.length === 0
        ? [
            `A bid on the Freelancer.com post${c.countryCode ? ` from ${c.countryCode}` : ''}; not ranked, compare it by hand.`,
          ]
        : c.reasons;
    for (const reason of reasons) {
      const li = document.createElement('li');
      li.textContent = reason;
      list.append(li);
    }
    why.append(list);

    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = c.shortlisted ? 'btn btn--secondary' : 'btn btn--primary';
    button.textContent = c.shortlisted ? 'Remove' : 'Shortlist';
    button.setAttribute(
      'aria-label',
      c.shortlisted ? `Remove ${c.name} from the shortlist` : `Shortlist ${c.name}`,
    );
    const reason = !mayWrite
      ? ROLE_REASON
      : !['open', 'shortlisting'].includes(r.status)
        ? `This request is ${STATUS_WORDS[r.status]?.toLowerCase() ?? r.status}, so its shortlist cannot change.`
        : '';
    if (reason) {
      button.disabled = true;
      button.title = reason;
    }
    button.addEventListener('click', () => void toggleShortlist(button, c));
    action.append(button);

    const margin = document.createElement('td');
    const judged = marginText(c);
    const figure = document.createElement('div');
    figure.className =
      judged.tone === 'none' ? '' : `badge badge--${judged.tone === 'ok' ? 'go' : 'skip'}`;
    figure.textContent = judged.text;
    figure.dataset.margin = judged.tone;
    margin.append(figure);
    if (judged.hint) {
      const why = document.createElement('div');
      why.className = 'field__hint';
      why.textContent = judged.hint;
      margin.append(why);
    }
    const reprice = document.createElement('button');
    reprice.type = 'button';
    reprice.className = 'btn btn--secondary';
    reprice.textContent = 'Reprice';
    reprice.setAttribute('aria-label', `Reprice the bid with ${c.name}’s quote`);
    const cannot = !mayWrite
      ? ROLE_REASON
      : c.quotedPriceMinor === null
        ? 'This candidate has no quote yet, so there is nothing to reprice with.'
        : '';
    if (cannot) {
      reprice.disabled = true;
      reprice.title = cannot;
    }
    reprice.addEventListener('click', () => void repriceCandidate(reprice, c));
    margin.append(reprice);

    tr.append(rank, who, rate, turnaround, score, margin, why, action);
    candidateRows.append(tr);
  });
  candidatesEmpty.hidden = candidates.length !== 0;
  excludedList.replaceChildren();
  for (const e of r.excluded) {
    const li = document.createElement('li');
    li.textContent = `${e.name}: ${e.reason}.`;
    excludedList.append(li);
  }
  excludedEmpty.hidden = r.excluded.length !== 0;
  section.hidden = false;
  for (const tr of rowsBody.querySelectorAll('tr')) {
    if (tr.dataset.id === r.id) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
  const params = new URLSearchParams();
  params.set('request', r.id);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

async function fetchList() {
  const body = /** @type {{ requests: SourcingRequest[] }} */ (
    await apiGet('/v1/sourcing-requests')
  );
  renderList(body.requests);
  return body.requests.length;
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
          ? 'No sourcing requests yet.'
          : `Loaded ${String(n)} sourcing request${n === 1 ? '' : 's'}.`,
    },
  );
}

/** @param {string} id */
async function loadRequest(id) {
  const body = /** @type {{ request: SourcingRequest }} */ (
    await apiGet(`/v1/sourcing-requests/${id}`)
  );
  renderRequest(body.request);
  void loadPosts(body.request);
  return body.request;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} id
 */
async function openRequest(button, id) {
  await runAction(
    button,
    requestStatus,
    async () => {
      try {
        return await loadRequest(id);
      } catch (error) {
        if (backToLoginOn401(error)) return null;
        throw error;
      }
    },
    {
      success: (r) =>
        r
          ? `Opened the sourcing request for ${r.briefTitle}: ${String(r.candidateCount)} supplier${r.candidateCount === 1 ? '' : 's'} ranked, ${String(r.excluded.length)} not ranked.`
          : '',
    },
  );
  section.scrollIntoView({ block: 'start' });
}

/**
 * @param {HTMLButtonElement} button
 * @param {Candidate} c
 */
async function toggleShortlist(button, c) {
  if (!current) return;
  const request = current;
  const shortlisted = !c.shortlisted;
  const outcome = await runAction(
    button,
    requestStatus,
    async () => {
      try {
        return /** @type {{ request: SourcingRequest }} */ (
          await apiSend('PATCH', `/v1/sourcing-requests/${request.id}/candidates/${c.id}`, {
            shortlisted,
          })
        );
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    {
      success: () =>
        shortlisted ? `Shortlisted ${c.name}.` : `Removed ${c.name} from the shortlist.`,
    },
  );
  if (outcome) {
    renderRequest(outcome.request);
    try {
      await fetchList();
    } catch (error) {
      if (backToLoginOn401(error)) return;
    }
  }
}

/**
 * Asks the reprice worker to judge the bid's margin with this candidate's quote.
 * @param {HTMLButtonElement} button
 * @param {Candidate} c
 */
async function repriceCandidate(button, c) {
  if (!current) return;
  const request = current;
  const outcome = await runAction(
    button,
    requestStatus,
    async () => {
      try {
        return await apiSend(
          'POST',
          `/v1/sourcing-requests/${request.id}/candidates/${c.id}/reprice`,
        );
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    {
      success: () =>
        `Asked for the bid to be priced with ${c.name}’s quote. The margin shows in the row once the worker has run; reopen the request to see it.`,
    },
  );
  if (outcome) {
    try {
      await loadRequest(request.id);
    } catch (error) {
      if (backToLoginOn401(error)) return;
    }
  }
}

refreshButton.addEventListener('click', () => void fetchAndRender(refreshButton));

const linked = new URLSearchParams(location.search).get('request');

void mountShell().then(async (me) => {
  if (!me) return;
  mayWrite = canWrite(me.role);
  setPostRoles({ mayWrite, mayApprove: canApprove(me.role) });
  if (linked) {
    try {
      const r = await loadRequest(linked);
      requestStatus.className = 'alert alert--success';
      requestStatus.textContent = `Opened the sourcing request for ${r.briefTitle}: ${String(r.candidateCount)} supplier${r.candidateCount === 1 ? '' : 's'} ranked, ${String(r.excluded.length)} not ranked.`;
    } catch (error) {
      if (backToLoginOn401(error)) return;
      requestStatus.className = 'alert alert--error';
      requestStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  void fetchAndRender(refreshButton);
});
