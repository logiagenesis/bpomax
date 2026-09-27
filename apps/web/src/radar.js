// @ts-check
import { formatTime } from './lib/format.js';
import { applyFilters } from './radar/filter.js';
import { fetchProjects, fetchSkills, nextDelayMs } from './radar/freelancer.js';
import { loadSettings, readJson, saveSettings, writeJson } from './radar/store.js';
import { budgetText, formatAge, formatAmount } from './radar/text.js';

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
  if (dismissed.has(project.id)) list.push(badge('Dismissed', 'skip'));
  return list;
}

/** @param {Project} project */
function row(project) {
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
  head.append(title);

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

function render() {
  const now = Date.now();
  const shown = applyFilters(projects, settings.filters, { acted: dismissed, now });
  feedList.replaceChildren(...shown.map((project) => row(project)));
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
  byId('detail-description').textContent = project.description;
  if (!detail.open) detail.showModal();
}

byId('detail-close').addEventListener('click', () => detail.close());

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
skillPicker('skills', 'watch', () => {
  // A new set of skills is a new search: read again once the picking pauses.
  clearTimeout(reread);
  reread = setTimeout(() => void refresh(), 1500);
});

// ------------------------------------------------------------------ settings

function fillSettings() {
  field(settingsForm, 'refreshMinutes').value = String(settings.refreshMinutes);
}

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
storageWarning.hidden = writeJson('probe', Date.now());
render();
void refresh();
