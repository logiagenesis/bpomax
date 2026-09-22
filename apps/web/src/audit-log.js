// @ts-check
import { EVENT_TYPES } from '@arbitron/core';
import { ApiError, apiGet, apiGetFile } from './lib/api.js';
import { downloadBlob } from './lib/download.js';
import { formatDateTime } from './lib/format.js';
import { runAction } from './lib/ui.js';

/**
 * The audit log page (ARB-062). Reads `GET /v1/events` — the API scopes it to the
 * signed-in org (D-015) — and never writes: the log is append-only by design and this page
 * has no button that could change it.
 */
const PAGE_SIZE = 25;
/** South Africa keeps no daylight saving, so the day boundary is a fixed +02:00 (D-024). */
const SAST = '+02:00';

/**
 * @typedef {object} EventRow
 * @property {string} id
 * @property {string} org_id
 * @property {string | null} actor_user_id
 * @property {string} actor_kind
 * @property {string} type
 * @property {string | null} subject_table
 * @property {string | null} subject_id
 * @property {string | null} request_id
 * @property {string | null} outcome
 * @property {Record<string, unknown>} payload
 * @property {string} created_at
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`audit log is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('filters'));
const typeSelect = /** @type {HTMLSelectElement} */ (byId('type'));
const actorSelect = /** @type {HTMLSelectElement} */ (byId('actor'));
const status = byId('status');
const applyButton = /** @type {HTMLButtonElement} */ (byId('apply'));
const clearButton = /** @type {HTMLButtonElement} */ (byId('clear'));
const exportButton = /** @type {HTMLButtonElement} */ (byId('export'));
const previousButton = /** @type {HTMLButtonElement} */ (byId('previous'));
const nextButton = /** @type {HTMLButtonElement} */ (byId('next'));
const results = byId('results');
const rowsBody = byId('rows');
const empty = byId('empty');
const count = byId('count');

// The type list is the vocabulary itself (packages/core), so it cannot drift from what
// the writer accepts.
for (const type of [...EVENT_TYPES].sort()) {
  const option = document.createElement('option');
  option.value = type;
  option.textContent = type;
  typeSelect.append(option);
}

/**
 * @param {string} inputId
 * @param {string} message empty to clear
 */
function setError(inputId, message) {
  const input = byId(inputId);
  const error = byId(`${inputId}-error`);
  error.textContent = message;
  error.hidden = message === '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * The filter as the API takes it. A date on the form means a whole South African day:
 * `from` is its first instant, `to` is the first instant of the day after (the API's upper
 * bound is exclusive).
 * @returns {{ type?: string, actor?: string, outcome?: string, from?: string, to?: string } | null}
 */
function readFilters() {
  const data = new FormData(form);
  const type = String(data.get('type') ?? '');
  const actor = String(data.get('actor') ?? '').trim();
  const outcome = String(data.get('outcome') ?? '');
  const fromDay = String(data.get('from') ?? '');
  const toDay = String(data.get('to') ?? '');

  setError('from', fromDay !== '' && Number.isNaN(Date.parse(fromDay)) ? 'Enter a date.' : '');
  setError(
    'to',
    toDay !== '' && Number.isNaN(Date.parse(toDay))
      ? 'Enter a date.'
      : fromDay !== '' && toDay !== '' && toDay < fromDay
        ? 'Must not be before the From date.'
        : '',
  );

  const firstInvalid = form.querySelector('[aria-invalid="true"]');
  if (firstInvalid instanceof HTMLElement) {
    firstInvalid.focus();
    return null;
  }

  /** @type {{ type?: string, actor?: string, outcome?: string, from?: string, to?: string }} */
  const filters = {};
  if (type) filters.type = type;
  if (actor) filters.actor = actor;
  if (outcome) filters.outcome = outcome;
  if (fromDay) filters.from = new Date(`${fromDay}T00:00:00${SAST}`).toISOString();
  if (toDay) {
    const next = new Date(`${toDay}T00:00:00${SAST}`);
    next.setUTCDate(next.getUTCDate() + 1);
    filters.to = next.toISOString();
  }
  return filters;
}

/** @type {{ type?: string, actor?: string, outcome?: string, from?: string, to?: string }} */
let current = {};
let offset = 0;

/** @type {Map<string, string>} */
const actorNames = new Map();

/** @param {EventRow} event */
function describeActor(event) {
  if (event.actor_kind === 'system') return 'System';
  if (!event.actor_user_id) return 'Unknown user';
  return actorNames.get(event.actor_user_id) ?? event.actor_user_id.slice(0, 8);
}

/**
 * The people who appear in this log, from the API (scoped by RLS like everything else).
 * Failure here is not fatal: the filter just offers no one, and the list still loads.
 */
async function loadActors() {
  try {
    const body = await apiGet(/** @type {any} */ ('/v1/events/actors'));
    const actors =
      /** @type {{ actors: { id: string, name: string | null, email: string | null }[] }} */ (body)
        .actors;
    for (const actor of actors) {
      const label = actor.name ?? actor.email ?? actor.id.slice(0, 8);
      actorNames.set(actor.id, label);
      const option = document.createElement('option');
      option.value = actor.id;
      option.textContent = actor.email && actor.name ? `${actor.name} (${actor.email})` : label;
      actorSelect.append(option);
    }
  } catch {
    /* the status line will already be showing why, from the events load */
  }
}

/** @param {EventRow} event */
function describeSubject(event) {
  if (!event.subject_table) return '';
  return event.subject_id
    ? `${event.subject_table} ${event.subject_id.slice(0, 8)}`
    : event.subject_table;
}

/** @param {EventRow} event */
function describePayload(event) {
  const keys = Object.keys(event.payload ?? {});
  if (keys.length === 0) return '';
  const text = JSON.stringify(event.payload);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** @param {string | null} outcome */
function outcomeBadge(outcome) {
  const badge = document.createElement('span');
  const kind =
    outcome === 'ok'
      ? 'go'
      : outcome === 'blocked'
        ? 'caution'
        : outcome === 'error'
          ? 'skip'
          : 'neutral';
  badge.className = `badge badge--${kind}`;
  badge.textContent = outcome ?? '—';
  return badge;
}

/** @param {EventRow[]} events */
function render(events) {
  rowsBody.replaceChildren();
  for (const event of events) {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.className = 'num';
    when.textContent = formatDateTime(event.created_at);
    const type = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = event.type;
    type.append(code);
    const actor = document.createElement('td');
    actor.textContent = describeActor(event);
    const outcome = document.createElement('td');
    outcome.append(outcomeBadge(event.outcome));
    const subject = document.createElement('td');
    subject.textContent = describeSubject(event);
    const details = document.createElement('td');
    details.textContent = describePayload(event);
    if (details.textContent) details.title = JSON.stringify(event.payload);
    tr.append(when, type, actor, outcome, subject, details);
    rowsBody.append(tr);
  }
  results.hidden = events.length === 0;
  empty.hidden = events.length !== 0;
  count.textContent =
    events.length === 0 ? '' : `Showing ${String(offset + 1)}–${String(offset + events.length)}`;
  lastPageSize = events.length;
}

let lastPageSize = 0;

/**
 * Applied after every load, not inside it: runAction re-enables the clicked button when
 * it finishes, so a state set during the load would be undone for that button.
 */
function syncControls() {
  previousButton.disabled = offset === 0;
  nextButton.disabled = lastPageSize < PAGE_SIZE;
  exportButton.disabled = lastPageSize === 0;
}

/** @returns {Promise<EventRow[]>} */
async function load() {
  const body = await apiGet(/** @type {any} */ ('/v1/events'), {
    ...current,
    limit: PAGE_SIZE,
    offset,
  });
  return /** @type {{ events: EventRow[] }} */ (body).events;
}

/** Keeps the filter in the address bar, so a view can be linked to. */
function reflectInUrl() {
  const params = new URLSearchParams();
  const data = new FormData(form);
  for (const key of ['type', 'from', 'to', 'actor', 'outcome']) {
    const value = String(data.get(key) ?? '');
    if (value) params.set(key, value);
  }
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

function applyFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of ['type', 'from', 'to', 'actor', 'outcome']) {
    const value = params.get(key);
    if (value) /** @type {HTMLInputElement | HTMLSelectElement} */ (byId(key)).value = value;
  }
  offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
}

/** @param {HTMLButtonElement} button */
async function fetchAndRender(button) {
  const events = await runAction(
    button,
    status,
    async () => {
      const loaded = await load();
      render(loaded);
      reflectInUrl();
      return loaded;
    },
    {
      success: (loaded) =>
        loaded.length === 0
          ? 'No events match these filters.'
          : `Loaded ${String(loaded.length)} event${loaded.length === 1 ? '' : 's'}.`,
    },
  );
  syncControls();
  return events;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const filters = readFilters();
  if (!filters) {
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  current = filters;
  offset = 0;
  void fetchAndRender(applyButton);
});

clearButton.addEventListener('click', () => {
  form.reset();
  for (const id of ['from', 'to']) setError(id, '');
  current = {};
  offset = 0;
  void fetchAndRender(clearButton);
});

previousButton.addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  void fetchAndRender(previousButton);
});

nextButton.addEventListener('click', () => {
  offset += PAGE_SIZE;
  void fetchAndRender(nextButton);
});

exportButton.addEventListener('click', () => {
  void runAction(
    exportButton,
    status,
    async () => {
      const file = await apiGetFile(/** @type {any} */ ('/v1/events.csv'), current);
      // The API names the file; this fallback matches its format should the header be missing.
      const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      downloadBlob(file.filename ?? `audit-log-${stamp}.csv`, file.blob);
      return {
        rows: Number(file.headers.get('x-export-rows') ?? 0),
        truncated: file.headers.get('x-export-truncated') === 'true',
      };
    },
    {
      success: ({ rows, truncated }) =>
        truncated
          ? `Exported the first ${String(rows)} matching events. Narrow the filter for the rest.`
          : `Exported ${String(rows)} event${rows === 1 ? '' : 's'}.`,
    },
  );
});

// First load: whatever the address bar says, or everything.
applyFromUrl();
const urlActor = new URLSearchParams(location.search).get('actor');
void loadActors().then(() => {
  // The address bar may name an actor the list has only just learned about.
  if (urlActor) actorSelect.value = urlActor;
  const initial = readFilters();
  if (initial) {
    current = initial;
    void fetchAndRender(applyButton);
  }
});

export { ApiError };
