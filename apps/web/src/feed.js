// @ts-check
import { canWrite, readOnlyPlatformReason } from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import { formatDateTime, formatMoney } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * The feed (ARB-061): `GET /v1/jobs` rendered as it is stored, and one button per row,
 * Queue bid → `POST /v1/jobs/:id/queue-bid`. The API decides whether a bid can be
 * drafted (apps/api/src/routes/jobs.ts) and this page shows its answer.
 */
const PAGE_SIZE = 25;

/**
 * @typedef {object} FeedRow
 * @property {string} id
 * @property {string} platform
 * @property {string} title
 * @property {string | null} currency
 * @property {string | null} budget_min_minor
 * @property {string | null} budget_max_minor
 * @property {boolean} hourly
 * @property {string | null} client_country
 * @property {boolean | null} client_payment_verified
 * @property {number | null} bid_count
 * @property {string | null} posted_at
 * @property {string} first_seen_at
 * @property {number | null} score
 * @property {string | null} verdict
 * @property {string[] | null} flags
 * @property {string | null} estimate_expected_minor
 * @property {string | null} estimate_currency
 * @property {string | null} estimate_method
 * @property {string | null} margin_minor
 * @property {string | null} margin_pct
 * @property {string | null} margin_currency
 * @property {boolean | null} margin_passed
 * @property {string | null} margin_reason
 * @property {string | null} proposal_id
 * @property {string | null} proposal_status
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`feed is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('filters'));
const verdictSelect = /** @type {HTMLSelectElement} */ (byId('verdict'));
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const previousButton = /** @type {HTMLButtonElement} */ (byId('previous'));
const nextButton = /** @type {HTMLButtonElement} */ (byId('next'));
const status = byId('status');
const results = byId('results');
const rowsBody = byId('rows');
const empty = byId('empty');
const count = byId('count');

let offset = 0;
let lastPageSize = 0;
let mayQueue = false;

const METHOD_WORDS = /** @type {Record<string, string>} */ ({
  in_house: 'in-house',
  rate_card: 'rate card',
  market_band: 'market band',
  candidate_quote: 'quote',
  ai_build: 'AI build',
});

const BID_WORDS = /** @type {Record<string, string>} */ ({
  draft: 'Drafting',
  queued: 'Waiting for approval',
  approved: 'Approved',
  submitted: 'Sent',
  rejected: 'Rejected',
  failed: 'Failed',
});

/** @param {FeedRow} job */
function budget(job) {
  if (!job.currency) return 'Not stated';
  const min = job.budget_min_minor;
  const max = job.budget_max_minor;
  const unit = job.hourly ? ' per hour' : '';
  if (min && max && min !== max)
    return `${formatMoney(BigInt(min), job.currency)} – ${formatMoney(BigInt(max), job.currency)}${unit}`;
  const one = max ?? min;
  return one ? `${formatMoney(BigInt(one), job.currency)}${unit}` : 'Not stated';
}

/** @param {string | null} verdict */
function verdictBadge(verdict) {
  const badge = document.createElement('span');
  badge.className = `badge badge--${verdict ?? 'neutral'}`;
  badge.textContent = verdict ? verdict.charAt(0).toUpperCase() + verdict.slice(1) : 'Not scored';
  return badge;
}

/** @param {FeedRow} job */
function queueBidState(job) {
  const readOnly = readOnlyPlatformReason(job.platform);
  if (readOnly) return readOnly;
  if (!mayQueue) return 'Your role can view the feed but not queue bids.';
  if (job.proposal_status && ['queued', 'approved', 'submitted'].includes(job.proposal_status)) {
    return `A bid is already ${BID_WORDS[job.proposal_status]?.toLowerCase() ?? job.proposal_status}.`;
  }
  return '';
}

/** @param {FeedRow[]} jobs */
function render(jobs) {
  rowsBody.replaceChildren();
  for (const job of jobs) {
    const tr = document.createElement('tr');

    const title = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = job.title;
    const meta = document.createElement('div');
    meta.className = 'field__hint';
    meta.textContent = [
      job.platform,
      job.client_country ? `client in ${job.client_country}` : null,
      job.client_payment_verified === false ? 'payment not verified' : null,
      job.bid_count !== null ? `${String(job.bid_count)} bids` : null,
      `seen ${formatDateTime(job.first_seen_at)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    title.append(strong, meta);

    const budgetCell = document.createElement('td');
    budgetCell.className = 'num';
    budgetCell.textContent = budget(job);

    const score = document.createElement('td');
    score.append(verdictBadge(job.verdict));
    if (job.score !== null) score.append(` ${String(job.score)}`);
    if (job.flags && job.flags.length > 0) {
      const flags = document.createElement('div');
      flags.className = 'field__hint';
      flags.textContent = job.flags.join(', ');
      score.append(flags);
    }

    const estimate = document.createElement('td');
    estimate.className = 'num';
    estimate.textContent =
      job.estimate_expected_minor && job.estimate_currency
        ? `${formatMoney(BigInt(job.estimate_expected_minor), job.estimate_currency)} (${METHOD_WORDS[job.estimate_method ?? ''] ?? job.estimate_method})`
        : 'None yet';

    const margin = document.createElement('td');
    margin.className = 'num';
    if (job.margin_minor && job.margin_currency && job.margin_pct) {
      margin.textContent = `${formatMoney(BigInt(job.margin_minor), job.margin_currency)} (${job.margin_pct.replace('.', ',')}%)`;
      const badge = document.createElement('span');
      badge.className = `badge badge--${job.margin_passed ? 'go' : 'skip'}`;
      badge.textContent = job.margin_passed ? 'Passed' : 'Failed';
      badge.title = job.margin_reason ?? '';
      margin.append(' ', badge);
    } else {
      margin.textContent = 'None yet';
    }

    const bid = document.createElement('td');
    bid.textContent = job.proposal_status
      ? (BID_WORDS[job.proposal_status] ?? job.proposal_status)
      : '—';

    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary';
    button.textContent = 'Queue bid';
    button.setAttribute('aria-label', `Queue bid for ${job.title}`);
    const reason = queueBidState(job);
    if (reason) {
      button.disabled = true;
      button.title = reason;
    }
    button.addEventListener('click', () => void queueBid(button, job));
    action.append(button);

    tr.append(title, budgetCell, score, estimate, margin, bid, action);
    rowsBody.append(tr);
  }
  results.hidden = jobs.length === 0;
  empty.hidden = jobs.length !== 0;
  count.textContent =
    jobs.length === 0 ? '' : `Showing ${String(offset + 1)}–${String(offset + jobs.length)}`;
  lastPageSize = jobs.length;
}

function syncControls() {
  previousButton.disabled = offset === 0;
  nextButton.disabled = lastPageSize < PAGE_SIZE;
}

function reflectInUrl() {
  const params = new URLSearchParams();
  if (verdictSelect.value) params.set('verdict', verdictSelect.value);
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

async function fetchList() {
  const body = await apiGet('/v1/jobs', {
    verdict: verdictSelect.value || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const jobs = /** @type {{ jobs: FeedRow[] }} */ (body).jobs;
  render(jobs);
  reflectInUrl();
  return jobs.length;
}

/** After Queue bid: the rows are refreshed and the button's own message stays on screen. */
async function reloadQuietly() {
  try {
    await fetchList();
  } catch (error) {
    if (backToLoginOn401(error)) return;
    status.className = 'alert alert--error';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  syncControls();
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
        n === 0 ? 'No jobs match this filter.' : `Loaded ${String(n)} job${n === 1 ? '' : 's'}.`,
    },
  );
  syncControls();
}

/**
 * @param {HTMLButtonElement} button
 * @param {FeedRow} job
 */
async function queueBid(button, job) {
  const outcome = await runAction(
    button,
    status,
    async () => {
      try {
        return /** @type {{ action: 'drafting' | 'scoring' }} */ (
          await apiSend('POST', `/v1/jobs/${job.id}/queue-bid`)
        );
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    {
      success: (result) =>
        result?.action === 'scoring'
          ? `“${job.title}” is being scored first. A bid is drafted once the margin passes; it will appear in Approvals.`
          : `A bid for “${job.title}” is being drafted. It will appear in Approvals.`,
    },
  );
  if (outcome) await reloadQuietly();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  offset = 0;
  void fetchAndRender(applyButton);
});
refreshButton.addEventListener('click', () => void fetchAndRender(refreshButton));
previousButton.addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  void fetchAndRender(previousButton);
});
nextButton.addEventListener('click', () => {
  offset += PAGE_SIZE;
  void fetchAndRender(nextButton);
});

const params = new URLSearchParams(location.search);
if (params.get('verdict')) verdictSelect.value = params.get('verdict') ?? '';
offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

void mountShell().then((me) => {
  if (!me) return;
  mayQueue = canWrite(me.role);
  void fetchAndRender(applyButton);
});
