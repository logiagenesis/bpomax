// @ts-check
import { EVENT_TYPES } from '@arbitron/core';
import { ApiError, apiGet, apiGetJson } from './lib/api.js';
import { formatDateTime, parseDateSast } from './lib/format.js';

/**
 * The audit log page (ARB-062): filter by type, actor and date; page through; export
 * the filtered log as CSV. Reads `GET /v1/events`, `/v1/events/actors` and
 * `/v1/events.csv` (apps/api/src/routes/events.ts).
 */
export const PAGE_SIZE = 50;

/**
 * @typedef {{ id: string, type: string, outcome: string | null, actor_kind: string,
 *   actor_user_id: string | null, subject_table: string | null, subject_id: string | null,
 *   payload: Record<string, unknown>, created_at: string }} EventRow
 * @typedef {{ id: string, name: string | null, email: string | null }} Actor
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`audit log page is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('filters'));
const typeSelect = /** @type {HTMLSelectElement} */ (byId('filter-type'));
const actorSelect = /** @type {HTMLSelectElement} */ (byId('filter-actor'));
const fromInput = /** @type {HTMLInputElement} */ (byId('filter-from'));
const toInput = /** @type {HTMLInputElement} */ (byId('filter-to'));
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const clearButton = /** @type {HTMLButtonElement} */ (byId('clear'));
const exportButton = /** @type {HTMLButtonElement} */ (byId('export'));
const newerButton = /** @type {HTMLButtonElement} */ (byId('newer'));
const olderButton = /** @type {HTMLButtonElement} */ (byId('older'));
const status = byId('status');
const table = byId('events');
const rows = byId('rows');
const empty = byId('empty');
const pageLabel = byId('page-label');

/** @type {Map<string, Actor>} */
const actors = new Map();
let offset = 0;
/** The filters in force, fixed when Apply is pressed, so paging never mixes filter sets. */
/** @type {Record<string, string | undefined>} */
let applied = {};

for (const type of EVENT_TYPES) {
  typeSelect.add(new Option(type, type));
}

/**
 * @param {'info' | 'success' | 'error' | ''} kind
 * @param {string} message
 */
function say(kind, message) {
  status.className = kind ? `alert alert--${kind}` : '';
  status.textContent = message;
}

/**
 * @param {HTMLInputElement} input
 * @param {string} message empty to clear
 */
function setError(input, message) {
  const error = byId(`${input.id}-error`);
  error.textContent = message;
  error.hidden = message === '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * Reads the form. Returns null, with the problems shown, when a date cannot be read.
 * @returns {Record<string, string | undefined> | null}
 */
function readFilters() {
  const fromText = fromInput.value.trim();
  const toText = toInput.value.trim();
  const from = fromText ? parseDateSast(fromText) : undefined;
  const to = toText ? parseDateSast(toText, { endOfDay: true }) : undefined;

  setError(fromInput, from === null ? 'Enter the date as DD/MM/YYYY, for example 01/09/2026.' : '');
  setError(toInput, to === null ? 'Enter the date as DD/MM/YYYY, for example 30/09/2026.' : '');
  if (from === null || to === null) return null;
  if (from && to && from >= to) {
    setError(toInput, 'The end date must be on or after the start date.');
    return null;
  }
  return {
    type: typeSelect.value || undefined,
    actor: actorSelect.value || undefined,
    from: from ?? undefined,
    to: to ?? undefined,
  };
}

/** @param {EventRow} event */
function actorLabel(event) {
  if (!event.actor_user_id) return 'System';
  const actor = actors.get(event.actor_user_id);
  return actor?.name ?? actor?.email ?? event.actor_user_id;
}

/** @param {string | null} outcome */
function outcomeBadge(outcome) {
  const badge = document.createElement('span');
  const kind = { ok: 'go', error: 'skip', blocked: 'skip', skipped: 'caution' }[outcome ?? ''];
  badge.className = `badge badge--${kind ?? 'neutral'}`;
  badge.textContent = outcome ?? '—';
  return badge;
}

/** @param {EventRow[]} events */
function render(events) {
  rows.replaceChildren();
  for (const event of events) {
    const tr = document.createElement('tr');
    const cells = [
      formatDateTime(event.created_at),
      event.type,
      outcomeBadge(event.outcome),
      actorLabel(event),
      event.subject_table
        ? `${event.subject_table}${event.subject_id ? ` ${event.subject_id.slice(0, 8)}` : ''}`
        : '—',
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      if (typeof cell === 'string') td.textContent = cell;
      else td.append(cell);
      tr.append(td);
    }
    const details = document.createElement('td');
    if (Object.keys(event.payload ?? {}).length > 0) {
      const disclosure = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Show';
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.margin = '0';
      pre.textContent = JSON.stringify(event.payload, null, 2);
      disclosure.append(summary, pre);
      details.append(disclosure);
    } else {
      details.textContent = '—';
    }
    tr.append(details);
    rows.append(tr);
  }
  empty.hidden = events.length > 0;
}

async function load() {
  table.setAttribute('aria-busy', 'true');
  applyButton.disabled = true;
  newerButton.disabled = true;
  olderButton.disabled = true;
  say('info', 'Loading…');
  try {
    /** @type {{ events: EventRow[] }} */
    const body = await apiGetJson('/v1/events', {
      ...applied,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    render(body.events);
    say('', '');
    newerButton.disabled = offset === 0;
    // A short page is the last one.
    olderButton.disabled = body.events.length < PAGE_SIZE;
    pageLabel.textContent =
      body.events.length > 0 ? `Entries ${offset + 1} to ${offset + body.events.length}` : '';
  } catch (error) {
    rows.replaceChildren();
    empty.hidden = true;
    pageLabel.textContent = '';
    say('error', error instanceof Error ? error.message : String(error));
    newerButton.disabled = offset === 0;
  } finally {
    table.setAttribute('aria-busy', 'false');
    applyButton.disabled = false;
  }
}

async function loadActors() {
  try {
    /** @type {{ actors: Actor[] }} */
    const body = await apiGetJson('/v1/events/actors');
    for (const actor of body.actors) {
      actors.set(actor.id, actor);
      actorSelect.add(new Option(actor.name ?? actor.email ?? actor.id, actor.id));
    }
  } catch {
    // The log itself reports the problem; the list just stays at "Everyone".
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const filters = readFilters();
  if (!filters) {
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid instanceof HTMLElement) firstInvalid.focus();
    say('error', 'A date needs fixing before the filters can be applied.');
    return;
  }
  applied = filters;
  offset = 0;
  void load();
});

clearButton.addEventListener('click', () => {
  form.reset();
  setError(fromInput, '');
  setError(toInput, '');
  applied = {};
  offset = 0;
  void load();
});

newerButton.addEventListener('click', () => {
  offset = Math.max(offset - PAGE_SIZE, 0);
  void load();
});

olderButton.addEventListener('click', () => {
  offset += PAGE_SIZE;
  void load();
});

exportButton.addEventListener('click', async () => {
  // The export is of the filters in force, the same entries the table is paging through.
  exportButton.disabled = true;
  exportButton.setAttribute('aria-busy', 'true');
  say('info', 'Preparing the export…');
  try {
    const response = await apiGet('/v1/events.csv', applied);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'audit-log.csv';
    const count = response.headers.get('x-export-rows') ?? '0';
    const truncated = response.headers.get('x-export-truncated') === 'true';

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);

    say(
      truncated ? 'info' : 'success',
      truncated
        ? `Exported the newest ${count} entries, the most one file holds. Narrow the dates to export the rest.`
        : `Exported ${count} ${count === '1' ? 'entry' : 'entries'} to ${filename}.`,
    );
  } catch (error) {
    say('error', error instanceof ApiError ? error.message : 'The export failed. Try again.');
  } finally {
    exportButton.disabled = false;
    exportButton.removeAttribute('aria-busy');
  }
});

await loadActors();
await load();
