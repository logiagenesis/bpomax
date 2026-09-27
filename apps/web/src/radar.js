// @ts-check
import { formatDateTime, formatTime } from './lib/format.js';
import { confirmAction } from './lib/ui.js';
import { applyFilters } from './radar/filter.js';
import { fetchProjects, fetchSkills, nextDelayMs } from './radar/freelancer.js';
import { PLACEHOLDERS, buildProposal, openingPrice } from './radar/proposal.js';
import { byRank, scoreProject } from './radar/score.js';
import { loadSettings, readJson, saveSettings, writeJson } from './radar/store.js';
import { bidsThisMonth, logEntry } from './radar/tracker.js';
import { budgetText, formatAge, formatAmount, formatPrice, formatRange } from './radar/text.js';

/**
 * The radar (LI-PROMPT-BPOMAX-RADAR-20260927): live Freelancer.com projects, read by this
 * page straight from Freelancer's public search (no server, no key, no sign-in), filtered
 * as the owner saves. Everything the owner keeps is in this browser's localStorage.
 * Nothing here submits anything on Freelancer.com: links open the project there.
 */

/**
 * @typedef {import('./radar/freelancer.js').Project} Project
 * @typedef {import('./radar/store.js').Skill} Skill
 * @typedef {import('./radar/store.js').Settings} Settings
 * @typedef {import('./radar/score.js').Score} Score
 * @typedef {import('./radar/proposal.js').Template} Template
 * @typedef {import('./radar/tracker.js').LogEntry} LogEntry
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`radar is missing #${id}`);
  return element;
}

const status = byId('status');
const updated = byId('updated');
const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const storageWarning = byId('storage-warning');
const feedList = byId('feed-list');
const feedCount = byId('feed-count');
const feedEmpty = byId('feed-empty');
const filtersForm = /** @type {HTMLFormElement} */ (byId('filters'));
const filtersError = byId('filters-error');
const settingsForm = /** @type {HTMLFormElement} */ (byId('settings'));
const settingsError = byId('settings-error');
const detail = /** @type {HTMLDialogElement} */ (byId('detail'));

const SKILLS_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Settings} */
let settings = loadSettings();
/** @type {Project[]} */
let projects = [];
/** @type {Set<number>} */
const dismissed = new Set(readJson('dismissed', /** @type {number[]} */ ([])));
/** @type {Template[]} */
let templates = readJson('templates', /** @type {Template[]} */ ([]));
/** @type {LogEntry[]} */
let log = readJson('log', /** @type {LogEntry[]} */ ([]));
let failures = 0;
let loading = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

// ------------------------------------------------------------------ storage

/**
 * Saves, and says so on the page when the browser will not keep it.
 * @param {string} key
 * @param {unknown} value
 */
function keep(key, value) {
  const ok = writeJson(key, value);
  storageWarning.hidden = ok;
  return ok;
}

function keepSettings() {
  storageWarning.hidden = saveSettings(settings);
}

// ------------------------------------------------------------------ messages

/**
 * @param {'info' | 'success' | 'warning' | 'error'} kind
 * @param {string} text
 */
function say(kind, text) {
  status.className = `alert alert--${kind}`;
  status.textContent = text;
}

// ------------------------------------------------------------------ tabs

const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);

/** @param {HTMLButtonElement} tab */
function selectTab(tab) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    byId(String(other.getAttribute('aria-controls'))).hidden = !selected;
  }
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) {
      selectTab(next);
      next.focus();
    }
  });
}

// ------------------------------------------------------------------ reading the feed

function schedule() {
  clearTimeout(timer);
  const delay = nextDelayMs(failures, settings.refreshMinutes);
  if (delay !== null) timer = setTimeout(() => void refresh(), delay);
  return delay;
}

async function refresh() {
  if (loading) return;
  loading = true;
  clearTimeout(timer);
  refreshButton.disabled = true;
  refreshButton.setAttribute('aria-busy', 'true');
  say('info', 'Reading Freelancer.com…');
  try {
    projects = await fetchProjects(settings.skills.map((skill) => skill.id));
    failures = 0;
    updated.textContent = `Last updated ${formatTime(Date.now())} SAST`;
    say('success', `Read ${String(projects.length)} projects from Freelancer.com.`);
    render();
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    const delay = nextDelayMs(failures, settings.refreshMinutes);
    say(
      'error',
      delay === null
        ? `${message} Press Refresh now to try again.`
        : `${message} Trying again at ${formatTime(Date.now() + delay)} SAST.`,
    );
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.removeAttribute('aria-busy');
    schedule();
  }
}

refreshButton.addEventListener('click', () => void refresh());

// ------------------------------------------------------------------ the feed

/** @param {Project} project */
function metaText(project) {
  const parts = [budgetText(project), `${String(project.bidCount)} bids`];
  if (project.bidAvg !== null) {
    parts.push(`average bid ${formatAmount(project.bidAvg * project.usdRate, 'USD')}`);
  }
  parts.push(formatAge(project.submitted, Date.now()));
  return parts.join(' · ');
}

/**
 * @param {string} text
 * @param {string} kind
 */
function badge(text, kind) {
  const span = document.createElement('span');
  span.className = `badge badge--${kind}`;
  span.textContent = text;
  return span;
}

/** @param {Project} project */
function flags(project) {
  const list = [];
  if (project.upgrades.nda) list.push(badge('NDA', 'caution'));
  if (project.upgrades.sealed) list.push(badge('Sealed', 'neutral'));
  if (project.upgrades.urgent) list.push(badge('Urgent', 'caution'));
  if (project.upgrades.featured) list.push(badge('Featured', 'neutral'));
  if (log.some((entry) => entry.projectId === project.id)) list.push(badge('Bid placed', 'go'));
  if (dismissed.has(project.id)) list.push(badge('Dismissed', 'skip'));
  return list;
}

/**
 * @param {Score} score
 */
function scoreBadge(score) {
  const box = document.createElement('span');
  box.className = `radar-score${score.total >= 70 ? ' radar-score--high' : score.total >= 40 ? ' radar-score--mid' : ''}`;
  box.textContent = String(score.total);
  box.title = 'Rank score out of 100';
  const note = document.createElement('span');
  note.className = 'visually-hidden';
  note.textContent = ' out of 100';
  box.append(note);
  return box;
}

/**
 * @param {Project} project
 * @param {Score} score
 */
function row(project, score) {
  const item = document.createElement('li');
  item.className = 'card radar-row';
  item.dataset['id'] = String(project.id);

  const head = document.createElement('div');
  head.className = 'radar-row__head';
  const title = document.createElement('h3');
  title.className = 'radar-row__title';
  const titleButton = document.createElement('button');
  titleButton.type = 'button';
  titleButton.dataset['action'] = 'detail';
  titleButton.textContent = project.title;
  title.append(titleButton);
  head.append(scoreBadge(score), title);

  const meta = document.createElement('p');
  meta.className = 'radar-row__meta';
  meta.textContent = metaText(project);

  const skills = document.createElement('p');
  skills.className = 'radar-row__skills';
  skills.textContent = project.skills.map((skill) => skill.name).join(' · ');

  const flagBox = document.createElement('div');
  flagBox.className = 'radar-flags';
  flagBox.append(...flags(project));

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const open = document.createElement('a');
  open.className = 'btn btn--secondary';
  open.href = project.url;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open';
  open.setAttribute('aria-label', `Open ${project.title} on Freelancer.com`);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn btn--ghost';
  dismiss.dataset['action'] = 'dismiss';
  dismiss.textContent = dismissed.has(project.id) ? 'Restore' : 'Dismiss';
  actions.append(open, dismiss);

  item.append(head, meta, skills, flagBox, actions);
  return item;
}

/** Projects bid on or dismissed. */
function acted() {
  const ids = new Set(dismissed);
  for (const entry of log) ids.add(entry.projectId);
  return ids;
}

function drawCounter() {
  const count = String(bidsThisMonth(log, Date.now()));
  byId('bid-counter').textContent =
    settings.monthlyLimit === null
      ? `Bids this month: ${count}`
      : `Bids this month: ${count} / ${String(settings.monthlyLimit)}`;
}

function render() {
  drawCounter();
  const now = Date.now();
  const shown = byRank(
    applyFilters(projects, settings.filters, { acted: acted(), now }).map((project) => ({
      project,
      score: scoreProject(project, settings, now),
    })),
  );
  feedList.replaceChildren(...shown.map(({ project, score }) => row(project, score)));
  feedCount.textContent = projects.length
    ? `Showing ${String(shown.length)} of the ${String(projects.length)} projects read.`
    : '';
  feedEmpty.hidden = shown.length > 0 || loading;
  feedEmpty.textContent = projects.length
    ? 'No project passes the filters. Loosen them to see more.'
    : 'No projects read yet.';
}

/** @param {number} id */
function projectById(id) {
  return projects.find((project) => project.id === id) ?? null;
}

feedList.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest('a')) return;
  const item = target.closest('li[data-id]');
  if (!(item instanceof HTMLElement)) return;
  const id = Number(item.dataset['id']);
  const project = projectById(id);
  if (!project) return;
  if (target.closest('[data-action="dismiss"]')) {
    if (dismissed.has(id)) {
      dismissed.delete(id);
      say('success', `Restored “${project.title}”.`);
    } else {
      dismissed.add(id);
      say('success', `Dismissed “${project.title}”.`);
    }
    keep('dismissed', [...dismissed]);
    render();
    return;
  }
  openDetail(project);
});

// ------------------------------------------------------------------ the detail panel

/** @param {Project} project */
function openDetail(project) {
  byId('detail-title').textContent = project.title;
  byId('detail-meta').textContent = metaText(project);
  byId('detail-skills').textContent = project.skills.map((skill) => skill.name).join(' · ');
  /** @type {HTMLAnchorElement} */ (byId('detail-open')).href = project.url;
  drawBreakdown(scoreProject(project, settings, Date.now()));
  byId('detail-description').textContent = project.description;
  shown = project;
  drawBid(project);
  if (!detail.open) detail.showModal();
}

// ------------------------------------------------------------------ the bid

const pForm = byId('p-form');
const pEmpty = byId('p-empty');
const pTemplate = /** @type {HTMLSelectElement} */ (byId('p-template'));
const pPrice = /** @type {HTMLInputElement} */ (byId('p-price'));
const pDays = /** @type {HTMLInputElement} */ (byId('p-days'));
const pText = /** @type {HTMLTextAreaElement} */ (byId('p-text'));
const pError = byId('p-error');
const bidPanel = byId('bid-panel');
const detailStatus = byId('detail-status');

/** @type {Project | null} */
let shown = null;
/** @type {{ project: Project, price: number, days: number, text: string, template: Template | null } | null} */
let pending = null;

/**
 * @param {'info' | 'success' | 'warning' | 'error'} kind
 * @param {string} text
 */
function sayInDetail(kind, text) {
  detailStatus.className = text ? `alert alert--${kind}` : '';
  detailStatus.textContent = text;
}

function chosenTemplate() {
  return templates.find((t) => t.id === pTemplate.value) ?? null;
}

function defaultTemplate() {
  return templates.find((t) => t.isDefault) ?? templates[0] ?? null;
}

/** The days box as a whole number from 1 to 365, or null. */
function readDays() {
  const days = parseNumber(pDays.value);
  return days !== null && Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}

/** The price box as a number above 0, or null. */
function readPrice() {
  const price = parseNumber(pPrice.value);
  return price !== null && price > 0 ? price : null;
}

/** @param {Project} project */
function drawPriceHint(project) {
  const budget = formatRange(project.budgetMin, project.budgetMax, project.currency);
  const price = readPrice();
  const parts = [budget ? `The client’s budget: ${budget}.` : 'The client gave no budget.'];
  if (price !== null && project.currency !== 'USD') {
    parts.push(`Your price is about ${formatAmount(price * project.usdRate, 'USD')}.`);
  }
  byId('p-price-hint').textContent = parts.join(' ');
}

function countText() {
  byId('p-count').textContent = `${String(pText.value.length)} characters`;
}

/** Writes the proposal again from the chosen template, price and days. */
function writeProposal() {
  const template = chosenTemplate();
  if (!shown || !template) return;
  pText.value = buildProposal(
    { ...shown, price: readPrice(), days: readDays() ?? settings.defaultDays },
    template,
    settings,
  );
  countText();
}

/** @param {Project} project */
function drawBid(project) {
  const placed = log.filter((entry) => entry.projectId === project.id);
  const note = byId('bid-placed');
  note.hidden = placed.length === 0;
  note.textContent = placed.length
    ? `You logged a bid on this project on ${formatDateTime(placed[0]?.placedAt ?? Date.now())} SAST.`
    : '';
  pending = null;
  bidPanel.hidden = true;
  pError.hidden = true;
  sayInDetail('info', '');
  pEmpty.hidden = templates.length > 0;
  pForm.hidden = templates.length === 0;
  if (!templates.length) return;

  const current = defaultTemplate();
  pTemplate.replaceChildren(
    ...templates.map((template) => {
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent = template.isDefault ? `${template.name} (default)` : template.name;
      option.selected = template.id === current?.id;
      return option;
    }),
  );
  byId('p-price-label').textContent =
    project.type === 'hourly'
      ? `Price per hour (${project.currency})`
      : `Price (${project.currency})`;
  const price = openingPrice(project, settings.pricePct);
  pPrice.value = price === null ? '' : String(price).replace('.', ',');
  pPrice.removeAttribute('aria-invalid');
  pDays.value = String(settings.defaultDays);
  pDays.removeAttribute('aria-invalid');
  drawPriceHint(project);
  writeProposal();
}

pTemplate.addEventListener('change', writeProposal);
pPrice.addEventListener('input', () => {
  pPrice.setAttribute('aria-invalid', String(readPrice() === null));
  if (shown) drawPriceHint(shown);
  writeProposal();
});
pDays.addEventListener('input', () => {
  pDays.setAttribute('aria-invalid', String(readDays() === null));
  writeProposal();
});
pText.addEventListener('input', countText);

byId('p-go-templates').addEventListener('click', () => {
  detail.close();
  selectTab(/** @type {HTMLButtonElement} */ (byId('tab-templates')));
  byId('t-name').focus();
});

/**
 * Puts text on the clipboard; false when the browser refuses.
 * @param {string} text
 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a Freelancer.com page in a new tab, cut off from this one.
 * @param {string} url
 */
function openTab(url) {
  const tab = window.open(url, '_blank');
  try {
    if (tab) tab.opener = null;
  } catch {
    // A cross-origin tab may refuse; it has no way back here either way.
  }
}

byId('p-bid').addEventListener('click', async () => {
  const project = shown;
  if (!project) return;
  const price = readPrice();
  const days = readDays();
  const problems = [];
  if (price === null) problems.push('Enter your price, a number above 0.');
  if (days === null) problems.push('Enter the delivery days, a whole number from 1 to 365.');
  if (!pText.value.trim()) problems.push('The proposal is empty.');
  pError.hidden = problems.length === 0;
  pError.textContent = problems.join(' ');
  if (price === null || days === null || problems.length) return;

  // 1. The proposal to the clipboard, 2. the project in a new tab, 3. the price to enter.
  if (await copy(pText.value)) {
    sayInDetail('success', 'Proposal copied. Paste it into your bid on Freelancer.com.');
  } else {
    pText.focus();
    pText.select();
    sayInDetail('warning', 'Copy failed — press Ctrl+C');
  }
  openTab(project.url);
  pending = { project, price, days, text: pText.value, template: chosenTemplate() };
  byId('bid-price-line').textContent =
    `Price to enter: ${formatPrice(price, project.currency)}${project.type === 'hourly' ? ' per hour' : ''} · Days: ${String(days)}`;
  /** @type {HTMLAnchorElement} */ (byId('bid-open-again')).href = project.url;
  bidPanel.hidden = false;
});

byId('bid-copy-price').addEventListener('click', async () => {
  if (!pending) return;
  const text = String(pending.price);
  if (await copy(text)) sayInDetail('success', `Price ${text} copied.`);
  else sayInDetail('warning', `Copy failed — the price is ${text}.`);
});

byId('bid-cancel').addEventListener('click', () => {
  pending = null;
  bidPanel.hidden = true;
  sayInDetail('info', 'Nothing was logged.');
});

byId('bid-placed-button').addEventListener('click', () => {
  if (!pending) return;
  const { project, price, days, text, template } = pending;
  const now = Date.now();
  const entry = logEntry(
    project,
    scoreProject(project, settings, now),
    {
      id: crypto.randomUUID(),
      price,
      days,
      proposal: text,
      template: template ? { id: template.id, name: template.name } : null,
    },
    now,
  );
  log = [entry, ...log];
  keep('log', log);
  pending = null;
  detail.close();
  render();
  say('success', `Logged your bid on “${project.title}”.`);
});

const PART_NAMES = /** @type {const} */ ([
  ['skill', 'Skill fit'],
  ['budget', 'Budget'],
  ['fresh', 'Freshness'],
  ['competition', 'Competition'],
]);

/**
 * Points with one decimal, as the rest of the app writes decimals: `12,5`.
 * @param {number} n
 */
const pts = (n) => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');

/** @param {Score} score */
function drawBreakdown(score) {
  byId('detail-score').textContent = `Rank score ${String(score.total)} of 100`;
  byId('detail-parts').replaceChildren(
    ...PART_NAMES.map(([key, name]) => {
      const part = score.parts[key];
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = name;
      const got = document.createElement('td');
      got.className = 'num';
      got.textContent = `${pts(part.points)} of ${pts(part.max)}`;
      const why = document.createElement('td');
      why.textContent = part.why;
      tr.append(th, got, why);
      return tr;
    }),
  );
}

byId('detail-close').addEventListener('click', () => detail.close());
detail.addEventListener('close', () => {
  shown = null;
  pending = null;
});

// ------------------------------------------------------------------ templates

const templateForm = /** @type {HTMLFormElement} */ (byId('template-form'));
const tName = /** @type {HTMLInputElement} */ (byId('t-name'));
const tBody = /** @type {HTMLTextAreaElement} */ (byId('t-body'));
const tDefault = /** @type {HTMLInputElement} */ (byId('t-default'));
const tCancel = /** @type {HTMLButtonElement} */ (byId('t-cancel'));
/** @type {string | null} */
let editing = null;

byId('placeholders').replaceChildren(
  ...PLACEHOLDERS.flatMap(([name, meaning]) => {
    const dt = document.createElement('dt');
    const code = document.createElement('code');
    code.textContent = name;
    dt.append(code);
    const dd = document.createElement('dd');
    dd.textContent = meaning;
    return [dt, dd];
  }),
);

function keepTemplates() {
  keep('templates', templates);
}

function drawTemplates() {
  byId('templates-empty').hidden = templates.length > 0;
  byId('template-list').replaceChildren(
    ...templates.map((template) => {
      const item = document.createElement('li');
      item.className = 'card stack';
      const head = document.createElement('div');
      head.className = 'radar-detail__head';
      const name = document.createElement('h3');
      name.textContent = template.name;
      head.append(name);
      if (template.isDefault) head.append(badge('Default', 'go'));
      const body = document.createElement('p');
      body.className = 'radar-description';
      body.textContent = template.body;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      /**
       * @param {string} label
       * @param {string} kind
       * @param {() => void} run
       */
      const button = (label, kind, run) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn--${kind}`;
        b.textContent = label;
        b.setAttribute('aria-label', `${label}: ${template.name}`);
        b.addEventListener('click', run);
        return b;
      };
      actions.append(
        button('Edit', 'secondary', () => editTemplate(template)),
        ...(template.isDefault
          ? []
          : [
              button('Make default', 'ghost', () => {
                templates = templates.map((t) => ({ ...t, isDefault: t.id === template.id }));
                keepTemplates();
                drawTemplates();
                say('success', `“${template.name}” is now the default template.`);
              }),
            ]),
        button('Delete', 'danger', async () => {
          const ok = await confirmAction({
            title: 'Delete this template?',
            body: `“${template.name}” is removed from this browser. Bids already logged keep their text.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          templates = templates.filter((t) => t.id !== template.id);
          if (editing === template.id) resetTemplateForm();
          keepTemplates();
          drawTemplates();
          say('success', `Deleted “${template.name}”.`);
        }),
      );
      item.append(head, body, actions);
      return item;
    }),
  );
}

/** @param {Template} template */
function editTemplate(template) {
  editing = template.id;
  tName.value = template.name;
  tBody.value = template.body;
  tDefault.checked = template.isDefault;
  byId('template-heading').textContent = `Edit “${template.name}”`;
  byId('t-save').textContent = 'Save the template';
  tCancel.hidden = false;
  tName.focus();
}

function resetTemplateForm() {
  editing = null;
  templateForm.reset();
  byId('template-heading').textContent = 'Add a template';
  byId('t-save').textContent = 'Add the template';
  tCancel.hidden = true;
  for (const id of ['t-name-error', 't-body-error']) byId(id).hidden = true;
  tName.removeAttribute('aria-invalid');
  tBody.removeAttribute('aria-invalid');
}

tCancel.addEventListener('click', resetTemplateForm);

templateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = tName.value.trim();
  const body = tBody.value.trim();
  const nameError = !name
    ? 'Give the template a name.'
    : templates.some((t) => t.id !== editing && t.name.toLowerCase() === name.toLowerCase())
      ? 'Another template has this name.'
      : '';
  const bodyError = body ? '' : 'Write the text of the template.';
  for (const [input, id, error] of /** @type {const} */ ([
    [tName, 't-name-error', nameError],
    [tBody, 't-body-error', bodyError],
  ])) {
    byId(id).hidden = !error;
    byId(id).textContent = error;
    input.setAttribute('aria-invalid', String(Boolean(error)));
  }
  if (nameError || bodyError) {
    (nameError ? tName : tBody).focus();
    return;
  }
  const isDefault = tDefault.checked || templates.every((t) => t.id === editing);
  const id = editing ?? crypto.randomUUID();
  const saved = { id, name, body, isDefault };
  const others = templates
    .filter((t) => t.id !== id)
    .map((t) => (isDefault ? { ...t, isDefault: false } : t));
  templates = editing
    ? templates.map((t) => (t.id === id ? saved : (others.find((o) => o.id === t.id) ?? t)))
    : [...others, saved];
  keepTemplates();
  const verb = editing ? 'Saved' : 'Added';
  resetTemplateForm();
  drawTemplates();
  say('success', `${verb} “${name}”.`);
});

// ------------------------------------------------------------------ filters

/**
 * A number typed in a box: blank is null, a decimal comma is accepted, anything else NaN.
 * @param {string} text
 */
function parseNumber(text) {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

/**
 * @param {HTMLFormElement} form
 * @param {string} name
 */
function field(form, name) {
  return /** @type {HTMLInputElement | HTMLSelectElement} */ (form.elements.namedItem(name));
}

const NUMBER_FILTERS = /** @type {const} */ ([
  'minBudgetUsd',
  'minHourlyUsd',
  'maxBids',
  'maxAgeHours',
]);

function fillFilters() {
  const f = settings.filters;
  field(filtersForm, 'type').value = f.type;
  for (const name of NUMBER_FILTERS) {
    const value = f[name];
    field(filtersForm, name).value = value === null ? '' : String(value).replace('.', ',');
  }
  field(filtersForm, 'excludeWords').value = f.excludeWords;
  /** @type {HTMLInputElement} */ (field(filtersForm, 'hideActed')).checked = f.hideActed;
}

filtersForm.addEventListener('input', () => {
  const next = { ...settings.filters };
  const type = field(filtersForm, 'type').value;
  next.type = type === 'fixed' || type === 'hourly' ? type : 'both';
  const bad = [];
  for (const name of NUMBER_FILTERS) {
    const input = field(filtersForm, name);
    const value = parseNumber(input.value);
    const invalid = Number.isNaN(value);
    input.setAttribute('aria-invalid', String(invalid));
    if (invalid) bad.push(input.labels?.[0]?.textContent ?? name);
    else next[name] = value;
  }
  next.excludeWords = field(filtersForm, 'excludeWords').value;
  next.hideActed = /** @type {HTMLInputElement} */ (field(filtersForm, 'hideActed')).checked;
  filtersError.hidden = bad.length === 0;
  filtersError.textContent = bad.length ? `Enter a number of 0 or more in: ${bad.join(', ')}.` : '';
  settings = { ...settings, filters: next };
  keepSettings();
  render();
});
filtersForm.addEventListener('submit', (event) => event.preventDefault());

// ------------------------------------------------------------------ skills

/** @type {Skill[] | null} */
let skillList = null;

/**
 * Freelancer's skills list, from this browser's copy while it is under 7 days old.
 * @returns {Promise<Skill[]>}
 */
async function skills() {
  if (skillList) return skillList;
  const cached = readJson(
    'skillsCache',
    /** @type {{ savedAt: number, skills: Skill[] } | null} */ (null),
  );
  if (cached && Date.now() - cached.savedAt < SKILLS_CACHE_MS && cached.skills.length) {
    skillList = cached.skills;
    return skillList;
  }
  skillList = await fetchSkills();
  writeJson('skillsCache', { savedAt: Date.now(), skills: skillList });
  return skillList;
}

/**
 * A searchable multi-select of Freelancer skills, saved as `settings[key]`.
 * @param {'skills' | 'inHouse'} key
 * @param {string} prefix the ids' prefix: `${prefix}-chosen`, `-search`, `-matches`
 * @param {() => void} onChange
 */
function skillPicker(key, prefix, onChange) {
  const chosen = byId(`${prefix}-chosen`);
  const search = /** @type {HTMLInputElement} */ (byId(`${prefix}-search`));
  const matches = byId(`${prefix}-matches`);

  function drawChosen() {
    chosen.replaceChildren(
      ...settings[key].map((skill) => {
        const item = document.createElement('li');
        item.className = 'radar-chip';
        item.append(skill.name);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${skill.name}`);
        remove.addEventListener('click', () => {
          set(settings[key].filter((s) => s.id !== skill.id));
          search.focus();
        });
        item.append(remove);
        return item;
      }),
    );
  }

  /** @param {Skill[]} next */
  function set(next) {
    settings = { ...settings, [key]: next };
    keepSettings();
    drawChosen();
    void drawMatches();
    onChange();
  }

  async function drawMatches() {
    const query = search.value.trim().toLowerCase();
    if (!query) {
      matches.replaceChildren();
      return;
    }
    let list;
    try {
      list = await skills();
    } catch (error) {
      const note = document.createElement('li');
      note.className = 'field__error';
      note.textContent = `Could not load Freelancer's skills list. ${error instanceof Error ? error.message : String(error)}`;
      matches.replaceChildren(note);
      return;
    }
    const found = list.filter((skill) => skill.name.toLowerCase().includes(query)).slice(0, 30);
    if (!found.length) {
      const note = document.createElement('li');
      note.className = 'field__hint';
      note.textContent = 'No skill has that in its name.';
      matches.replaceChildren(note);
      return;
    }
    matches.replaceChildren(
      ...found.map((skill) => {
        const item = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = settings[key].some((s) => s.id === skill.id);
        box.addEventListener('change', () => {
          set(
            box.checked
              ? [...settings[key].filter((s) => s.id !== skill.id), skill]
              : settings[key].filter((s) => s.id !== skill.id),
          );
        });
        label.append(box, ` ${skill.name}`);
        item.append(label);
        return item;
      }),
    );
  }

  search.addEventListener('input', () => void drawMatches());
  drawChosen();
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let reread;
skillPicker('inHouse', 'inhouse', () => render());
skillPicker('skills', 'watch', () => {
  // A new set of skills is a new search: read again once the picking pauses.
  clearTimeout(reread);
  reread = setTimeout(() => void refresh(), 1500);
});

// ------------------------------------------------------------------ settings

const WEIGHTS = /** @type {const} */ (['skill', 'budget', 'fresh', 'competition']);

/**
 * The number boxes in settings: the setting, its lowest and highest value, whether it may
 * be left blank, and whether it must be whole.
 * @type {readonly (readonly ['pricePct' | 'defaultDays' | 'monthlyLimit', number, number, boolean, boolean])[]}
 */
const NUMBER_SETTINGS = [
  ['pricePct', 1, 100, false, true],
  ['defaultDays', 1, 365, false, true],
  ['monthlyLimit', 1, 100_000, true, true],
];

function fillSettings() {
  field(settingsForm, 'refreshMinutes').value = String(settings.refreshMinutes);
  for (const key of WEIGHTS) {
    field(settingsForm, `w-${key}`).value = String(settings.weights[key]);
  }
  for (const [name] of NUMBER_SETTINGS) {
    const value = settings[name];
    field(settingsForm, name).value = value === null ? '' : String(value).replace('.', ',');
  }
}

/**
 * Reads a whole-number box; shows and returns null when it is not one from `min` to `max`.
 * @param {HTMLInputElement} input
 * @param {number} min
 * @param {number} max
 */
function wholeIn(input, min, max) {
  const value = parseNumber(input.value);
  const ok = value !== null && Number.isInteger(value) && value >= min && value <= max;
  input.setAttribute('aria-invalid', String(!ok));
  return ok ? value : null;
}

settingsForm.addEventListener('input', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!(target instanceof HTMLInputElement) || target.type === 'search') return;
  const next = { ...settings, weights: { ...settings.weights } };
  const bad = [];
  for (const key of WEIGHTS) {
    const input = /** @type {HTMLInputElement} */ (field(settingsForm, `w-${key}`));
    const value = wholeIn(input, 0, 100);
    if (value === null)
      bad.push(`${input.labels?.[0]?.textContent ?? key}: a whole number from 0 to 100.`);
    else next.weights[key] = value;
  }
  for (const [name, min, max, blank, whole] of NUMBER_SETTINGS) {
    const input = /** @type {HTMLInputElement} */ (field(settingsForm, name));
    const value = parseNumber(input.value);
    const ok =
      value === null
        ? blank
        : !Number.isNaN(value) &&
          value >= min &&
          value <= max &&
          (!whole || Number.isInteger(value));
    input.setAttribute('aria-invalid', String(!ok));
    const rule = `${whole ? 'a whole number' : 'a number'} from ${String(min)} to ${String(max)}${blank ? ', or blank' : ''}`;
    if (!ok) bad.push(`${input.labels?.[0]?.textContent ?? name}: ${rule}.`);
    else next[name] = /** @type {number} */ (value);
  }
  settingsError.hidden = bad.length === 0;
  settingsError.textContent = bad.join(' ');
  settings = next;
  keepSettings();
  render();
});

settingsForm.addEventListener('change', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!(target instanceof HTMLSelectElement) || target.name !== 'refreshMinutes') return;
  const minutes = Number(target.value);
  settings = {
    ...settings,
    refreshMinutes: minutes === 2 || minutes === 5 || minutes === 10 ? minutes : 0,
  };
  keepSettings();
  const delay = schedule();
  say(
    'success',
    delay === null
      ? 'The feed is read only when you press Refresh now.'
      : `The feed is read every ${String(settings.refreshMinutes)} minutes.`,
  );
});
settingsForm.addEventListener('submit', (event) => event.preventDefault());
settingsError.hidden = true;

// ------------------------------------------------------------------ start

fillFilters();
fillSettings();
drawTemplates();
storageWarning.hidden = writeJson('probe', Date.now());
render();
void refresh();
