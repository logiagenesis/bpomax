// @ts-check
import { apiGet } from './lib/api.js';
import { formatMoney, formatNanoUsd, formatRatio } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * Analytics (ARB-320, docs/01 section I). `GET /v1/analytics?by=&since=`: each row as the
 * API grouped it with `aggregateAnalytics` in core. The page only formats: a rate as
 * "66,7 % (2 of 3)" or "No data (0 of 0)", money in the one money format, model spend in
 * US dollars to the millionth. Nothing is recalculated here.
 */

/**
 * @typedef {{ numerator: number, denominator: number, percent: string | null }} Ratio
 * @typedef {object} Row
 * @property {string | null} key
 * @property {string} label
 * @property {number} bids
 * @property {number} replies
 * @property {Ratio} replyRate
 * @property {number} won
 * @property {number} lost
 * @property {Ratio} winRate
 * @property {string} realisedMarginZarMinor
 * @property {number} unconvertedPayments
 * @property {string} modelCostNanoUsd
 * @property {string | null} costPerReplyNanoUsd
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`analytics is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('filters'));
const bySelect = /** @type {HTMLSelectElement} */ (byId('by'));
const sinceInput = /** @type {HTMLInputElement} */ (byId('since'));
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const status = byId('status');
const results = byId('results');
const rowsBody = byId('rows');
const totalFoot = byId('total');
const groupHeading = byId('group-heading');
const unconverted = byId('unconverted');
const empty = byId('empty');

const GROUP_WORDS = /** @type {Record<string, string>} */ ({
  category: 'Category',
  template: 'Template',
  supplier: 'Supplier',
  scanner: 'Scanner',
});

/**
 * @param {Row} row
 * @param {'td' | 'th'} first
 */
function tableRow(row, first) {
  const tr = document.createElement('tr');
  const cells = [
    row.label,
    String(row.bids),
    formatRatio(row.replyRate),
    formatRatio(row.winRate),
    formatMoney(BigInt(row.realisedMarginZarMinor), 'ZAR'),
    row.costPerReplyNanoUsd === null ? 'No replies' : formatNanoUsd(row.costPerReplyNanoUsd),
  ];
  for (const [i, text] of cells.entries()) {
    const cell = document.createElement(i === 0 ? first : 'td');
    if (i === 0 && first === 'th') cell.setAttribute('scope', 'row');
    if (i > 0) cell.className = 'num';
    cell.textContent = text;
    tr.append(cell);
  }
  return tr;
}

/** DD/MM/YYYY as an ISO day, or null when it is not a real date. */
function isoDay(/** @type {string} */ text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * @param {string} by
 * @param {string | null} since ISO day
 */
async function fetchAnalytics(by, since) {
  const body = /** @type {{ by: string, total: Row, rows: Row[] }} */ (
    await apiGet('/v1/analytics', since ? { by, since } : { by })
  );
  groupHeading.textContent = GROUP_WORDS[body.by] ?? body.by;
  rowsBody.replaceChildren(...body.rows.map((r) => tableRow(r, 'th')));
  totalFoot.replaceChildren(tableRow(body.total, 'th'));
  const left = body.total.unconvertedPayments;
  unconverted.hidden = left === 0;
  unconverted.textContent = `${String(left)} payment${left === 1 ? '' : 's'} not in rand with no rate ${left === 1 ? 'is' : 'are'} left out of realised margin; record ${left === 1 ? 'its' : 'their'} rate on the pipeline page.`;
  results.hidden = body.total.bids === 0;
  empty.hidden = body.total.bids !== 0;
  const params = new URLSearchParams();
  if (by !== 'category') params.set('by', by);
  if (since) params.set('since', since);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  return body;
}

async function load() {
  clearFieldErrors(form);
  const typed = sinceInput.value.trim();
  const since = typed === '' ? null : isoDay(typed);
  if (typed !== '' && since === null) {
    showFieldErrors(form, [{ field: 'since', message: 'must be a real date as DD/MM/YYYY' }]);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  await runAction(
    applyButton,
    status,
    async () => {
      try {
        return await fetchAnalytics(bySelect.value, since);
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    {
      success: (body) =>
        !body
          ? ''
          : body.total.bids === 0
            ? 'No bids sent yet.'
            : `Counted ${String(body.total.bids)} bid${body.total.bids === 1 ? '' : 's'} by ${(GROUP_WORDS[body.by] ?? body.by).toLowerCase()}.`,
    },
  );
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void load();
});

const params = new URLSearchParams(location.search);
const wantedBy = params.get('by');
if (wantedBy && [...bySelect.options].some((o) => o.value === wantedBy)) bySelect.value = wantedBy;
const wantedSince = params.get('since');
if (wantedSince && /^\d{4}-\d{2}-\d{2}$/.test(wantedSince)) {
  const [y, m, d] = wantedSince.split('-');
  sinceInput.value = `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

void mountShell().then((me) => {
  if (!me) return;
  void load();
});
