// @ts-check
import { canWrite, validateSupplierCsv } from '@arbitron/core';
import { ApiError, apiGet, apiGetFile, apiSend } from './lib/api.js';
import { downloadBlob } from './lib/download.js';
import { formatMoney, formatPercent } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * The supplier database (ARB-200): `GET /v1/suppliers` as it is stored; the template
 * from `GET /v1/suppliers/template.csv`; the export from `GET /v1/suppliers.csv`; and
 * the import, checked here with the same rule the API runs (`validateSupplierCsv`)
 * before `POST /v1/suppliers/import` is asked to write. Every problem is shown with the
 * line it is on, and nothing is imported unless every line is right.
 */

/**
 * @typedef {object} RateCard
 * @property {string} id
 * @property {string} categorySlug
 * @property {string} categoryName
 * @property {string} currency
 * @property {string | null} fixedPriceMinor
 * @property {string | null} hourlyRateMinor
 * @property {number | null} turnaroundDays
 */

/**
 * @typedef {object} Supplier
 * @property {string} id
 * @property {string} name
 * @property {string | null} countryCode
 * @property {string | null} timeZone
 * @property {string} channel
 * @property {string[]} languages
 * @property {string | null} qualityScore
 * @property {string | null} onTimeRate
 * @property {boolean} paysAfterDelivery
 * @property {string | null} externalProfileUrl
 * @property {string | null} notes
 * @property {boolean} active
 * @property {RateCard[]} rateCards
 */

/** @typedef {{ line: number, field: string, message: string }} LineError */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`suppliers is missing #${id}`);
  return element;
}

const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const templateButton = /** @type {HTMLButtonElement} */ (byId('download-template'));
const exportButton = /** @type {HTMLButtonElement} */ (byId('export'));
const status = byId('status');
const importForm = /** @type {HTMLFormElement} */ (byId('import-form'));
const fileInput = /** @type {HTMLInputElement} */ (byId('import-file'));
const textInput = /** @type {HTMLTextAreaElement} */ (byId('import-text'));
const checkButton = /** @type {HTMLButtonElement} */ (byId('import-check'));
const runButton = /** @type {HTMLButtonElement} */ (byId('import-run'));
const report = byId('import-report');
const summary = byId('import-summary');
const errorList = byId('import-errors');
const results = byId('results');
const rowsBody = byId('rows');
const empty = byId('empty');
const count = byId('count');

let mayImport = false;
const ROLE_REASON = 'Your role can view suppliers but not import them.';
/** @type {Set<string>} */
let categories = new Set();

const CHANNEL_WORDS = /** @type {Record<string, string>} */ ({
  freelancer: 'Freelancer.com',
  upwork: 'Upwork',
  fiverr: 'Fiverr',
  direct: 'Direct',
  in_house: 'In-house',
  ai_build: 'AI build',
});

/** `85.00` → `85`, `0.950` → `95,0%`: the stored text, shown; nothing recalculated. */
function decimalText(/** @type {string} */ text) {
  return text.replace(/\.?0+$/, '').replace('.', ',');
}

/** @param {RateCard} card */
function rateText(card) {
  const parts = [];
  if (card.fixedPriceMinor !== null)
    parts.push(`${formatMoney(BigInt(card.fixedPriceMinor), card.currency)} fixed`);
  if (card.hourlyRateMinor !== null)
    parts.push(`${formatMoney(BigInt(card.hourlyRateMinor), card.currency)} an hour`);
  if (card.turnaroundDays !== null)
    parts.push(`${String(card.turnaroundDays)} day${card.turnaroundDays === 1 ? '' : 's'}`);
  return `${card.categoryName}: ${parts.join(', ')}`;
}

/** @param {Supplier[]} suppliers */
function render(suppliers) {
  rowsBody.replaceChildren();
  let cards = 0;
  for (const s of suppliers) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;

    const who = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'field__hint';
    meta.textContent = [
      CHANNEL_WORDS[s.channel] ?? s.channel,
      s.countryCode,
      s.timeZone,
      s.languages.length > 0 ? s.languages.join(', ') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    who.append(strong, meta);
    if (s.externalProfileUrl) {
      const link = document.createElement('a');
      link.href = s.externalProfileUrl;
      link.textContent = 'Profile';
      link.rel = 'noopener';
      link.target = '_blank';
      who.append(' ', link);
    }
    if (s.notes) {
      const notes = document.createElement('div');
      notes.className = 'field__hint';
      notes.textContent = s.notes;
      who.append(notes);
    }

    const quality = document.createElement('td');
    quality.className = 'num';
    quality.textContent =
      [
        s.qualityScore !== null ? `${decimalText(s.qualityScore)} / 100` : null,
        s.onTimeRate !== null ? `${formatPercent(Number(s.onTimeRate))} on time` : null,
      ]
        .filter(Boolean)
        .join(', ') || 'Not recorded';

    const pays = document.createElement('td');
    pays.textContent = s.paysAfterDelivery ? 'Yes' : 'No';

    const rates = document.createElement('td');
    if (s.rateCards.length === 0) rates.textContent = 'None';
    else {
      const list = document.createElement('ul');
      list.className = 'stack';
      for (const card of s.rateCards) {
        const li = document.createElement('li');
        li.textContent = rateText(card);
        list.append(li);
      }
      rates.append(list);
    }
    cards += s.rateCards.length;

    const active = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge badge--${s.active ? 'go' : 'neutral'}`;
    badge.textContent = s.active ? 'Active' : 'Inactive';
    active.append(badge);

    tr.append(who, quality, pays, rates, active);
    rowsBody.append(tr);
  }
  results.hidden = suppliers.length === 0;
  empty.hidden = suppliers.length !== 0;
  count.textContent =
    suppliers.length === 0
      ? ''
      : `${String(suppliers.length)} supplier${suppliers.length === 1 ? '' : 's'}, ${String(cards)} rate card${cards === 1 ? '' : 's'}.`;
}

async function fetchList() {
  const body = /** @type {{ suppliers: Supplier[] }} */ (await apiGet('/v1/suppliers'));
  render(body.suppliers);
  return body.suppliers.length;
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
        n === 0 ? 'No suppliers yet.' : `Loaded ${String(n)} supplier${n === 1 ? '' : 's'}.`,
    },
  );
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} path
 * @param {string} fallbackName
 * @param {(rows: number) => string} success
 */
async function download(button, path, fallbackName, success) {
  await runAction(
    button,
    status,
    async () => {
      try {
        const file = await apiGetFile(path);
        downloadBlob(file.filename ?? fallbackName, file.blob);
        return Number(file.headers.get('x-export-rows') ?? 0);
      } catch (error) {
        if (backToLoginOn401(error)) return 0;
        throw error;
      }
    },
    { success },
  );
}

/** @param {LineError[]} errors */
function showLineErrors(errors) {
  errorList.replaceChildren();
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = `Line ${String(e.line)}${e.field ? `, ${e.field}` : ''}: ${e.message}.`;
    errorList.append(li);
  }
  const lines = new Set(errors.map((e) => e.line)).size;
  summary.textContent = `${String(lines)} line${lines === 1 ? ' has' : 's have'} problems; nothing was imported.`;
  report.hidden = false;
}

/** @param {string} text */
function showOutcome(text) {
  errorList.replaceChildren();
  summary.textContent = text;
  report.hidden = false;
}

/** The CSV as typed or as chosen; the file wins when both are given. */
async function readCsv() {
  const file = fileInput.files?.[0];
  if (file) return file.text();
  return textInput.value;
}

/**
 * @param {HTMLButtonElement} button
 * @param {boolean} dryRun
 */
async function importCsv(button, dryRun) {
  clearFieldErrors(importForm);
  report.hidden = true;
  const csv = await readCsv();
  if (csv.trim() === '') {
    showFieldErrors(
      importForm,
      [{ field: 'file', message: 'choose a file or paste the CSV first' }],
      'import-',
    );
    return;
  }
  const checked = validateSupplierCsv(csv, { categories });
  if (!checked.ok) {
    showLineErrors(checked.errors);
    status.className = 'alert alert--error';
    status.textContent = summary.textContent ?? '';
    return;
  }
  await runAction(
    button,
    status,
    async () => {
      try {
        return /** @type {{ dryRun: boolean, suppliers: number, rateCards: number, created: number, updated: number }} */ (
          await apiSend('POST', '/v1/suppliers/import', { csv, dryRun })
        );
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        if (error instanceof ApiError && error.errors.length > 0) {
          const lineErrors = /** @type {LineError[]} */ (error.errors.filter((e) => 'line' in e));
          if (lineErrors.length > 0) {
            showLineErrors(lineErrors);
            throw new Error(summary.textContent ?? error.message);
          }
          showFieldErrors(importForm, error.errors, 'import-');
        }
        throw error;
      }
    },
    {
      success: (result) => {
        if (!result) return '';
        const text = result.dryRun
          ? `The file is fine: ${String(result.suppliers)} supplier${result.suppliers === 1 ? '' : 's'} and ${String(result.rateCards)} rate card${result.rateCards === 1 ? '' : 's'} would be imported.`
          : `Imported ${String(result.suppliers)} supplier${result.suppliers === 1 ? '' : 's'} and ${String(result.rateCards)} rate card${result.rateCards === 1 ? '' : 's'} (${String(result.created)} new, ${String(result.updated)} updated).`;
        showOutcome(text);
        return text;
      },
    },
  );
  if (!dryRun) {
    try {
      await fetchList();
    } catch (error) {
      if (backToLoginOn401(error)) return;
    }
  }
}

refreshButton.addEventListener('click', () => void fetchAndRender(refreshButton));
templateButton.addEventListener('click', () => {
  void download(
    templateButton,
    '/v1/suppliers/template.csv',
    'suppliers-template.csv',
    () => 'Downloaded the template. Replace its sample line with your suppliers.',
  );
});
exportButton.addEventListener('click', () => {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  void download(
    exportButton,
    '/v1/suppliers.csv',
    `suppliers-${stamp}.csv`,
    (rows) => `Exported ${String(rows)} supplier${rows === 1 ? '' : 's'}.`,
  );
});
checkButton.addEventListener('click', () => void importCsv(checkButton, true));
importForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void importCsv(runButton, false);
});

void mountShell().then(async (me) => {
  if (!me) return;
  mayImport = canWrite(me.role);
  for (const button of [checkButton, runButton]) {
    button.disabled = !mayImport;
    if (!mayImport) button.title = ROLE_REASON;
  }
  try {
    const body = /** @type {{ categories: { slug: string }[] }} */ (
      await apiGet('/v1/service-categories')
    );
    categories = new Set(body.categories.map((c) => c.slug));
  } catch (error) {
    if (backToLoginOn401(error)) return;
  }
  void fetchAndRender(refreshButton);
});
