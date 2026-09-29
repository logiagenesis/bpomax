// @ts-check
import { downloadBlob } from './lib/download.js';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatTime,
} from './lib/format.js';
import { confirmAction } from './lib/ui.js';
import { TOKEN_KEY, fetchSelf, maskToken, tokenProblem, tokenState } from './radar/account.js';
import { NOTIFIED_KEPT, pickAlerts } from './radar/alerts.js';
import { fetchDevelopers, pickDevelopers, toShortlist } from './radar/developers.js';
import { applyFilters } from './radar/filter.js';
import { FreelancerError, fetchProjects, fetchSkills, nextDelayMs } from './radar/freelancer.js';
import { placeBid, statusOf } from './radar/placing.js';
import {
  PLACEHOLDERS,
  buildProposal,
  openingPrice,
  unfilledMessage,
  unfilledPlaceholders,
} from './radar/proposal.js';
import { byRank, scoreProject } from './radar/score.js';
import {
  backupFilename,
  backupOf,
  loadSettings,
  parseBackup,
  readJson,
  restore,
  saveSettings,
  writeJson,
} from './radar/store.js';
import {
  bidsThisMonth,
  computeTotals,
  logEntry,
  monthlyLimitProblem,
  withStatus,
} from './radar/tracker.js';
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
 * @typedef {import('./radar/tracker.js').BidStatus} BidStatus
 * @typedef {import('./radar/tracker.js').Totals} Totals
 * @typedef {import('./radar/tracker.js').Rate} Rate
 * @typedef {import('./radar/developers.js').Developer} Developer
 * @typedef {import('./radar/developers.js').Shortlisted} Shortlisted
 * @typedef {import('./radar/account.js').StoredToken} StoredToken
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
/** @type {Shortlisted[]} */
let shortlist = readJson('shortlist', /** @type {Shortlisted[]} */ ([]));
/** @type {number[]} */
let notified = readJson('notified', /** @type {number[]} */ ([]));
/** @type {{ project: Project, score: Score }[]} */
let ranked = [];
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
  if (tab.id === 'tab-bids') drawBids();
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
    drawToken();
    notifyNew();
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

/** Says so above the feed while the rank has no skills or in-house ticks to work from. */
function drawRankNote() {
  byId('rank-note').hidden = settings.skills.length > 0 && settings.inHouse.length > 0;
}

function render() {
  drawCounter();
  drawRankNote();
  const now = Date.now();
  const shown = byRank(
    applyFilters(projects, settings.filters, { acted: acted(), now }).map((project) => ({
      project,
      score: scoreProject(project, settings, now),
    })),
  );
  ranked = shown;
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
  const canPlace = tokenReady() !== null && placed.length === 0;
  byId('p-place').hidden = !canPlace;
  byId('p-place-hint').hidden = !canPlace;
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
  const unfilled = unfilledMessage(unfilledPlaceholders(pText.value));
  if (unfilled) problems.push(unfilled);
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
  drawBids();
  pending = null;
  detail.close();
  render();
  say('success', `Logged your bid on “${project.title}”.`);
});

const placeButton = /** @type {HTMLButtonElement} */ (byId('p-place'));
placeButton.addEventListener('click', async () => {
  const project = shown;
  const ready = tokenReady();
  if (!project || !ready) return;
  const price = readPrice();
  const days = readDays();
  const text = pText.value.trim();
  const problems = [];
  if (price === null) problems.push('Enter your price, a number above 0.');
  if (days === null) problems.push('Enter the delivery days, a whole number from 1 to 365.');
  if (!text) problems.push('The proposal is empty.');
  const unfilled = unfilledMessage(unfilledPlaceholders(text));
  if (unfilled) problems.push(unfilled);
  const overLimit = monthlyLimitProblem(log, settings.monthlyLimit, Date.now());
  if (overLimit) problems.push(overLimit);
  pError.hidden = problems.length === 0;
  pError.textContent = problems.join(' ');
  if (price === null || days === null || problems.length) return;
  const priceText = `${formatPrice(price, project.currency)}${project.type === 'hourly' ? ' per hour' : ''}`;
  const ok = await confirmAction({
    title: 'Place this bid on Freelancer.com now?',
    body: `A real bid on “${project.title}” as ${ready.account.username}: ${priceText}, ${String(days)} days, with the proposal as it is here. It counts against your bids for the month.`,
    confirmLabel: 'Place the bid',
  });
  if (!ok) return;
  placeButton.disabled = true;
  placeButton.setAttribute('aria-busy', 'true');
  sayInDetail('info', 'Placing the bid on Freelancer.com…');
  const template = chosenTemplate();
  try {
    const result = await placeBid(ready.token, {
      projectId: project.id,
      bidderId: ready.account.id,
      price,
      days,
      description: text,
    });
    const now = Date.now();
    const entry = {
      ...logEntry(
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
      ),
      placedBy: /** @type {const} */ ('manual'),
      freelancerBidId: result.bidId,
      apiStatus: result.status,
    };
    log = [entry, ...log];
    keep('log', log);
    drawBids();
    detail.close();
    render();
    say(
      'success',
      result.outcome === 'already'
        ? `Freelancer.com already has your bid ${result.bidId} on “${project.title}”, so nothing new was sent. It is logged.`
        : `Placed your bid on “${project.title}” on Freelancer.com (bid ${result.bidId}). It is logged.`,
    );
  } catch (error) {
    const status = statusOf(error);
    const message = error instanceof Error ? error.message : String(error);
    sayInDetail(
      'error',
      status === 401 || status === 403
        ? `${message}. Check the token in Settings.`
        : `${message}.`.replace(/\.\.$/, '.'),
    );
  } finally {
    placeButton.disabled = false;
    placeButton.removeAttribute('aria-busy');
  }
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
  drawRankNote();
  // A new set of skills is a new search: read again once the picking pauses.
  clearTimeout(reread);
  reread = setTimeout(() => void refresh(), 1500);
});

// ------------------------------------------------------------------ bids

/** @param {number} usd */
const usdText = (usd) => formatMoney(Math.round(usd * 100), 'USD');
/** @param {number} zar */
const zarText = (zar) => formatMoney(Math.round(zar * 100), 'ZAR');

/** @param {Rate} r */
function rateText(r) {
  const of = `(${String(r.numerator)} of ${String(r.denominator)})`;
  return r.ratio === null ? `No data ${of}` : `${formatPercent(r.ratio)} ${of}`;
}

/**
 * @param {Totals} t
 * @param {string} title
 */
function totalsCard(t, title) {
  const card = document.createElement('section');
  card.className = 'card stack';
  const h = document.createElement('h2');
  h.textContent = title;
  const dl = document.createElement('dl');
  dl.className = 'radar-totals';
  const withZar = (/** @type {string} */ usd, /** @type {number | undefined} */ zar) =>
    zar === undefined ? usd : `${usd} · ${zarText(zar)}`;
  const margin =
    withZar(usdText(t.marginUsd), t.zar?.margin) +
    (t.feeUsd === null ? ' (fee not set)' : ` after fees of ${usdText(t.feeUsd)}`);
  for (const [name, value] of /** @type {[string, string][]} */ ([
    ['Bids', String(t.bids)],
    ['Replies', String(t.replies)],
    ['Reply rate', rateText(t.replyRate)],
    ['Awards', String(t.awards)],
    ['Win rate (awards ÷ replies)', rateText(t.winRate)],
    ['Awarded value', withZar(usdText(t.awardedUsd), t.zar?.awarded)],
    ['Delivery cost', withZar(usdText(t.deliveryUsd), t.zar?.delivery)],
    ['Margin', margin],
  ])) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  card.append(h, dl);
  return card;
}

/**
 * @param {import('./radar/tracker.js').Split[]} rows
 * @param {string} caption
 * @param {string} first
 */
function splitTable(rows, caption, first) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'table';
  const cap = document.createElement('caption');
  cap.textContent = caption;
  const head = document.createElement('tr');
  for (const [text, num] of /** @type {[string, boolean][]} */ ([
    [first, false],
    ['Bids', true],
    ['Replies', true],
    ['Reply rate', true],
    ['Awards', true],
    ['Win rate', true],
  ])) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = text;
    if (num) th.className = 'num';
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = r.name;
    tr.append(th);
    for (const value of [
      String(r.bids),
      String(r.replies),
      rateText(r.replyRate),
      String(r.awards),
      rateText(r.winRate),
    ]) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  wrap.append(table);
  return wrap;
}

function drawTotals() {
  const { month, all } = computeTotals(log, settings, Date.now());
  byId('totals').replaceChildren(totalsCard(month, 'This month'), totalsCard(all, 'All time'));
  for (const [id, t] of /** @type {[string, Totals][]} */ ([
    ['splits-month-body', month],
    ['splits-all-body', all],
  ])) {
    byId(id).replaceChildren(
      splitTable(t.byTemplate, 'By template', 'Template'),
      splitTable(t.byBand, 'By rank score', 'Rank score'),
    );
  }
}

const STATUS_WORDS = /** @type {Record<BidStatus, string>} */ ({
  sent: 'Sent',
  replied: 'Replied',
  awarded: 'Awarded',
  lost: 'Lost',
  'no-reply': 'No reply',
});
const STATUS_KIND = /** @type {Record<BidStatus, string>} */ ({
  sent: 'neutral',
  replied: 'live',
  awarded: 'go',
  lost: 'skip',
  'no-reply': 'caution',
});

/**
 * Replaces one logged bid, saves the log and redraws the figures.
 * @param {string} id
 * @param {(entry: LogEntry) => LogEntry} change
 */
function updateBid(id, change) {
  log = log.map((entry) => (entry.id === id ? change(entry) : entry));
  keep('log', log);
  drawTotals();
  return log.find((entry) => entry.id === id) ?? null;
}

/** @param {LogEntry} entry */
function marginText(entry) {
  if (!entry.award) return '';
  const value = entry.award.agreedPrice * entry.usdRate;
  const fee = settings.feePct === null ? null : (value * settings.feePct) / 100;
  const margin = value - entry.award.deliveryCostUsd - (fee ?? 0);
  const zar = settings.usdToZar === null ? '' : ` · ${zarText(margin * settings.usdToZar)}`;
  return `Awarded ${usdText(value)}. Margin ${usdText(margin)}${zar}${fee === null ? ' (fee not set)' : ` after a ${String(settings.feePct).replace('.', ',')} % fee of ${usdText(fee)}`}.`;
}

/**
 * The award's figures, saved as they are typed.
 * @param {LogEntry} entry
 */
function awardForm(entry) {
  const award = entry.award ?? {
    agreedPrice: entry.price,
    deliveryCostUsd: 0,
    developer: null,
    note: '',
  };
  const box = document.createElement('div');
  box.className = 'stack';
  const grid = document.createElement('div');
  grid.className = 'radar-award';
  const line = document.createElement('p');
  line.className = 'field__hint';
  line.textContent = marginText(entry);
  const error = document.createElement('p');
  error.className = 'field__error';
  error.hidden = true;

  /**
   * @param {string} key
   * @param {string} label
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @param {string} [hint]
   */
  const labelled = (key, label, input, hint) => {
    const field = document.createElement('div');
    field.className = 'field';
    const l = document.createElement('label');
    l.className = 'field__label';
    l.htmlFor = `${key}-${entry.id}`;
    l.textContent = label;
    input.id = `${key}-${entry.id}`;
    field.append(l, input);
    if (hint) {
      const h = document.createElement('p');
      h.className = 'field__hint';
      h.textContent = hint;
      field.append(h);
    }
    return field;
  };

  const agreed = document.createElement('input');
  agreed.className = 'input';
  agreed.inputMode = 'decimal';
  agreed.value = String(award.agreedPrice).replace('.', ',');
  const cost = document.createElement('input');
  cost.className = 'input';
  cost.inputMode = 'decimal';
  cost.value = String(award.deliveryCostUsd).replace('.', ',');
  const note = document.createElement('textarea');
  note.className = 'textarea';
  note.rows = 2;
  note.value = award.note;

  const save = () => {
    const a = parseNumber(agreed.value);
    const c = parseNumber(cost.value);
    const okA = a !== null && !Number.isNaN(a);
    const okC = c !== null && !Number.isNaN(c);
    agreed.setAttribute('aria-invalid', String(!okA));
    cost.setAttribute('aria-invalid', String(!okC));
    error.hidden = okA && okC;
    error.textContent =
      okA && okC ? '' : 'Enter the agreed value and the delivery cost as numbers (0 for in-house).';
    const saved = updateBid(entry.id, (e) => ({
      ...e,
      award: {
        agreedPrice: okA ? a : (e.award?.agreedPrice ?? e.price),
        deliveryCostUsd: okC ? c : (e.award?.deliveryCostUsd ?? 0),
        developer: e.award?.developer ?? null,
        note: note.value,
      },
    }));
    if (saved) line.textContent = marginText(saved);
  };
  for (const input of [agreed, cost, note]) input.addEventListener('input', save);

  const who = document.createElement('select');
  who.className = 'select';
  const inHouse = document.createElement('option');
  inHouse.value = '';
  inHouse.textContent = 'In-house';
  who.append(inHouse);
  const names = new Set(shortlist.map((d) => d.username));
  if (award.developer && !names.has(award.developer)) names.add(award.developer);
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    who.append(option);
  }
  who.value = award.developer ?? '';
  who.addEventListener('change', () => {
    const developer = who.value || null;
    const picked = shortlist.find((d) => d.username === developer);
    // The delivery cost starts from the shortlisted developer's rate, or 0 in-house.
    if (!developer) cost.value = '0';
    else if (picked?.rateUsd !== null && picked?.rateUsd !== undefined) {
      cost.value = String(picked.rateUsd).replace('.', ',');
    }
    updateBid(entry.id, (e) => ({
      ...e,
      award: { ...(e.award ?? award), developer },
    }));
    save();
  });

  const whoField = document.createElement('div');
  whoField.className = 'field';
  const whoLabel = document.createElement('label');
  whoLabel.className = 'field__label';
  whoLabel.htmlFor = `who-${entry.id}`;
  whoLabel.textContent = 'Delivered by';
  who.id = `who-${entry.id}`;
  whoField.append(whoLabel, who);
  grid.append(
    whoField,
    labelled(
      'agreed',
      `Agreed value (${entry.currency})`,
      agreed,
      entry.type === 'hourly'
        ? 'For an hourly project, what you expect to bill in all.'
        : undefined,
    ),
    labelled('cost', 'Delivery cost (USD)', cost, '0 when Logi-Ink delivers it in-house.'),
  );
  box.append(grid, labelled('note', 'Note', note), error, line);
  return box;
}

/** @param {LogEntry} entry */
function bidItem(entry) {
  const item = document.createElement('li');
  item.className = 'card stack';
  item.dataset['bid'] = entry.id;
  const head = document.createElement('div');
  head.className = 'radar-detail__head';
  const title = document.createElement('h3');
  title.className = 'radar-row__title';
  const link = document.createElement('a');
  link.href = entry.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = entry.title;
  title.append(link);
  head.append(title, badge(STATUS_WORDS[entry.status], STATUS_KIND[entry.status]));

  const meta = document.createElement('p');
  meta.className = 'radar-row__meta';
  meta.textContent = [
    `Placed ${formatDateTime(entry.placedAt)} SAST`,
    `${formatPrice(entry.price, entry.currency)}${entry.type === 'hourly' ? ' per hour' : ''}`,
    `${String(entry.days)} days`,
    entry.templateName ? `template ${entry.templateName}` : 'no template',
    `score ${String(entry.score)}`,
    entry.replied ? 'the client replied' : 'no reply yet',
    ...(entry.freelancerBidId ? [`Freelancer.com bid ${entry.freelancerBidId}`] : []),
  ].join(' · ');

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', `Status of ${entry.title}`);
  for (const status of /** @type {BidStatus[]} */ ([
    'replied',
    'awarded',
    'lost',
    'no-reply',
    'sent',
  ])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--secondary';
    b.textContent = status === 'sent' ? 'Back to sent' : STATUS_WORDS[status];
    b.setAttribute('aria-pressed', String(entry.status === status));
    b.addEventListener('click', () => {
      const saved = updateBid(entry.id, (e) => withStatus(e, status));
      if (saved) item.replaceWith(bidItem(saved));
      say('success', `“${entry.title}” is marked ${STATUS_WORDS[status].toLowerCase()}.`);
    });
    actions.append(b);
  }
  item.append(head, meta, actions);
  if (entry.status === 'awarded') item.append(awardForm(entry));
  return item;
}

function drawBids() {
  drawTotals();
  byId('bids-empty').hidden = log.length > 0;
  byId('bid-list').replaceChildren(...log.map(bidItem));
}

// ------------------------------------------------------------------ developers

const devQuery = /** @type {HTMLInputElement} */ (byId('dev-query'));
const devGo = /** @type {HTMLButtonElement} */ (byId('dev-go'));
/** @type {Developer[]} */
let found = [];
let searched = '';

function keepShortlist() {
  keep('shortlist', shortlist);
}

/**
 * @param {number | null} ratio
 */
const completionText = (ratio) =>
  ratio === null ? 'completion not given' : `${formatPercent(ratio)} completed`;

/** @param {number | null} rating */
const ratingText = (rating) =>
  rating === null ? 'no rating' : `rated ${rating.toFixed(2).replace('.', ',')} of 5`;

/** @param {Developer} d */
function developerItem(d) {
  const item = document.createElement('li');
  item.className = 'card stack';
  const head = document.createElement('div');
  head.className = 'radar-detail__head';
  const name = document.createElement('h3');
  name.className = 'radar-row__title';
  const link = document.createElement('a');
  link.href = d.profile;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = d.username;
  name.append(link);
  head.append(name);
  const meta = document.createElement('p');
  meta.className = 'radar-row__meta';
  meta.textContent = [
    d.country ?? 'country not given',
    d.hourlyRateUsd === null ? 'no hourly rate' : `${formatPrice(d.hourlyRateUsd, 'USD')} an hour`,
    `${String(d.jobs)} jobs`,
    `${String(d.reviews)} reviews`,
    ratingText(d.rating),
    completionText(d.completionRate),
  ].join(' · ');
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const listed = shortlist.some((s) => s.username === d.username);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn--secondary';
  add.textContent = listed ? 'Shortlisted' : 'Shortlist';
  add.disabled = listed;
  add.setAttribute(
    'aria-label',
    listed ? `${d.username} is shortlisted` : `Shortlist ${d.username}`,
  );
  add.addEventListener('click', () => {
    shortlist = [...shortlist, toShortlist(d)];
    keepShortlist();
    drawDevelopers();
    say('success', `Shortlisted ${d.username}.`);
  });
  actions.append(add);
  item.append(head, meta, actions);
  return item;
}

/** @param {Shortlisted} d */
function shortlistItem(d) {
  const item = document.createElement('li');
  item.className = 'card stack';
  const head = document.createElement('div');
  head.className = 'radar-detail__head';
  const name = document.createElement('h3');
  name.className = 'radar-row__title';
  const link = document.createElement('a');
  link.href = d.profile;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = d.username;
  name.append(link);
  head.append(name);
  const meta = document.createElement('p');
  meta.className = 'radar-row__meta';
  meta.textContent = [
    d.country ?? 'country not given',
    d.hourlyRateUsd === null
      ? 'no hourly rate'
      : `${formatPrice(d.hourlyRateUsd, 'USD')} an hour on their profile`,
    `${String(d.reviews)} reviews`,
    ratingText(d.rating),
  ].join(' · ');

  const grid = document.createElement('div');
  grid.className = 'radar-award';
  const rateField = document.createElement('div');
  rateField.className = 'field';
  const rateLabel = document.createElement('label');
  rateLabel.className = 'field__label';
  rateLabel.htmlFor = `rate-${d.username}`;
  rateLabel.textContent = 'Your price or rate for them (USD)';
  const rate = document.createElement('input');
  rate.className = 'input';
  rate.id = `rate-${d.username}`;
  rate.inputMode = 'decimal';
  rate.value = d.rateUsd === null ? '' : String(d.rateUsd).replace('.', ',');
  rateField.append(rateLabel, rate);
  const noteField = document.createElement('div');
  noteField.className = 'field';
  const noteLabel = document.createElement('label');
  noteLabel.className = 'field__label';
  noteLabel.htmlFor = `dnote-${d.username}`;
  noteLabel.textContent = 'Note';
  const note = document.createElement('input');
  note.className = 'input';
  note.id = `dnote-${d.username}`;
  note.value = d.note;
  noteField.append(noteLabel, note);
  grid.append(rateField, noteField);

  const save = () => {
    const value = parseNumber(rate.value);
    const ok = !Number.isNaN(value);
    rate.setAttribute('aria-invalid', String(!ok));
    shortlist = shortlist.map((s) =>
      s.username === d.username ? { ...s, rateUsd: ok ? value : s.rateUsd, note: note.value } : s,
    );
    keepShortlist();
  };
  rate.addEventListener('input', save);
  note.addEventListener('input', save);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn--ghost';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${d.username} from the shortlist`);
  remove.addEventListener('click', () => {
    shortlist = shortlist.filter((s) => s.username !== d.username);
    keepShortlist();
    drawDevelopers();
    say('success', `Removed ${d.username} from the shortlist.`);
  });
  actions.append(remove);
  item.append(head, meta, grid, actions);
  return item;
}

function drawDevelopers() {
  byId('dev-filters').textContent =
    `Shows freelancers with at least ${String(settings.devMinCompletion).replace('.', ',')} % of jobs completed and at least ${String(settings.devMinReviews)} reviews, best rated first. Change this in Settings.`;
  const kept = pickDevelopers(found, settings);
  byId('dev-results').replaceChildren(...kept.map(developerItem));
  byId('shortlist-empty').hidden = shortlist.length > 0;
  byId('shortlist').replaceChildren(...shortlist.map(shortlistItem));
  return kept.length;
}

byId('dev-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = devQuery.value.trim();
  if (!query) {
    devQuery.setAttribute('aria-invalid', 'true');
    say('error', 'Type what to search for, for example wordpress.');
    return;
  }
  devQuery.removeAttribute('aria-invalid');
  devGo.disabled = true;
  devGo.setAttribute('aria-busy', 'true');
  say('info', 'Searching Freelancer.com…');
  try {
    found = await fetchDevelopers(query);
    searched = query;
    const kept = drawDevelopers();
    say(
      'success',
      `Found ${String(found.length)} freelancers for “${searched}”; ${String(kept)} meet your filters.`,
    );
  } catch (error) {
    say('error', error instanceof Error ? error.message : String(error));
  } finally {
    devGo.disabled = false;
    devGo.removeAttribute('aria-busy');
  }
});

// ------------------------------------------------------------------ export and import

const IMPORTED = 'radar.imported';

byId('export').addEventListener('click', () => {
  const now = Date.now();
  const backup = backupOf(
    {
      settings,
      templates,
      log,
      dismissed: [...dismissed],
      shortlist,
    },
    now,
  );
  const name = backupFilename(now);
  downloadBlob(name, new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  say('success', `Exported everything to ${name}. Keep it somewhere safe.`);
});

const importFile = /** @type {HTMLInputElement} */ (byId('import-file'));
byId('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  let backup;
  try {
    backup = parseBackup(await file.text());
  } catch (error) {
    say('error', error instanceof Error ? error.message : String(error));
    return;
  }
  const when = `${formatDateTime(backup.exportedAt)} SAST`;
  const ok = await confirmAction({
    title: 'Replace everything here with this backup?',
    body: `Your settings, templates, ${String(log.length)} logged bids, dismissed projects and shortlist in this browser are replaced by the ones in ${file.name}, exported ${when}, with ${String(backup.log.length)} logged bids. Export first to keep what is here.`,
    confirmLabel: 'Replace',
    danger: true,
  });
  if (!ok) {
    say('info', 'Nothing was imported.');
    return;
  }
  if (!restore(backup)) {
    say('error', 'This browser would not keep the backup (private window or blocked site data).');
    return;
  }
  try {
    sessionStorage.setItem(IMPORTED, `Imported ${file.name}, exported ${when}.`);
  } catch {
    // The message after the reload is a courtesy; the import itself is done.
  }
  location.reload();
});

// ------------------------------------------------------------------ alerts

/** Whether this browser can show notifications at all. */
const canNotify = () => typeof Notification === 'function';

function drawAlertState() {
  const state = byId('alerts-state');
  if (!canNotify()) {
    state.textContent = 'This browser cannot show notifications.';
  } else if (Notification.permission === 'denied') {
    state.textContent =
      'Notifications are blocked for this site in your browser’s settings, so alerts stay off.';
  } else if (settings.alertsOn && Notification.permission === 'granted') {
    state.textContent = `Alerts are on for projects scoring ${String(settings.alertThreshold)} or more.`;
  } else {
    state.textContent = 'Alerts are off.';
  }
}

/** One notification per fresh project at or above the threshold, while the tab is open. */
function notifyNew() {
  if (!settings.alertsOn || !canNotify() || Notification.permission !== 'granted') return;
  const picked = pickAlerts(ranked, {
    threshold: settings.alertThreshold,
    notified: new Set(notified),
    now: Date.now(),
  });
  if (!picked.length) return;
  let failed = false;
  for (const { project, score } of picked) {
    try {
      const note = new Notification(`Radar ${String(score.total)}: ${project.title}`, {
        body: budgetText(project),
        tag: `radar-${String(project.id)}`,
      });
      note.addEventListener('click', () => {
        window.focus();
        openDetail(project);
        note.close();
      });
    } catch {
      // Some phone browsers show notifications only from an installed app.
      failed = true;
    }
    notified.push(project.id);
  }
  notified = notified.slice(-NOTIFIED_KEPT);
  keep('notified', notified);
  if (failed) {
    say(
      'warning',
      'This browser shows notifications only from installed apps, so alerts cannot show here.',
    );
  }
}

// ------------------------------------------------------------------ Freelancer token

const tokenForm = /** @type {HTMLFormElement} */ (byId('token-form'));
const tokenInput = /** @type {HTMLInputElement} */ (byId('token-input'));
const tokenError = byId('token-error');
const tokenStateLine = byId('token-state');
const tokenAccount = byId('token-account');
const tokenSave = /** @type {HTMLButtonElement} */ (byId('token-save'));
const tokenCheck = /** @type {HTMLButtonElement} */ (byId('token-check'));
const tokenRemove = /** @type {HTMLButtonElement} */ (byId('token-remove'));
const tokenWarning = byId('token-warning');
const DEVELOP = 'accounts.freelancer.com/settings/develop';

/** @type {StoredToken | null} */
let stored = readJson(TOKEN_KEY, /** @type {StoredToken | null} */ (null));

/**
 * The saved token and its account, when Freelancer.com accepted it at the last check and
 * its 30 days are not over; else null.
 * @returns {{ token: string, account: import('./radar/account.js').Account } | null}
 */
function tokenReady() {
  if (!stored?.account || stored.problem) return null;
  if (tokenState(stored, Date.now()).kind === 'expired') return null;
  return { token: stored.token, account: stored.account };
}

/** @param {string} text */
function showTokenError(text) {
  tokenError.textContent = text;
  tokenError.hidden = !text;
  tokenInput.setAttribute('aria-invalid', String(Boolean(text)));
}

/** Why Freelancer.com would not take the token, in a line Dennis can act on. */
function refusal(/** @type {unknown} */ error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof FreelancerError && (error.status === 401 || error.status === 403)) {
    return `Token rejected (${message.replace(/^Freelancer\.com answered /, '').replace(/\.$/, '')}). Generate a new one at ${DEVELOP}.`;
  }
  return message;
}

function drawToken() {
  const state = tokenState(stored, Date.now());
  tokenCheck.hidden = !stored;
  tokenRemove.hidden = !stored;
  tokenSave.textContent = stored ? 'Replace and check' : 'Save and check';
  if (!stored || state.expiresAt === null) {
    tokenStateLine.textContent = 'No token saved.';
    tokenAccount.hidden = true;
    tokenWarning.hidden = true;
    return;
  }
  const until = formatDate(state.expiresAt);
  tokenStateLine.textContent = `Token ${maskToken(stored.token)}, pasted ${formatDate(stored.savedAt)}, ${
    state.kind === 'expired' ? `ran out on ${until}` : `lasts until ${until}`
  }.`;
  const a = stored.account;
  tokenAccount.hidden = false;
  if (stored.problem) {
    tokenAccount.textContent = stored.problem;
  } else if (a) {
    const plan = a.membership
      ? `, ${a.membership} membership${a.bidLimit === null ? '' : `, ${String(a.bidLimit)} bids a ${a.bidPeriod ?? 'period'}`}`
      : '';
    const checked = stored.checkedAt ? ` Checked ${formatDateTime(stored.checkedAt)} SAST.` : '';
    tokenAccount.textContent = `Freelancer.com says this is ${a.username} (user ${String(a.id)})${plan}${a.limited ? ', a limited account' : ''}.${checked}`;
  } else {
    tokenAccount.hidden = true;
  }
  tokenWarning.hidden = state.kind !== 'soon' && state.kind !== 'expired';
  tokenWarning.textContent =
    state.kind === 'expired'
      ? `Your Freelancer token ran out on ${until}. Generate a new one at ${DEVELOP} and paste it in Settings.`
      : `Your Freelancer token runs out on ${until}, in ${String(state.daysLeft)} ${state.daysLeft === 1 ? 'day' : 'days'}. Generate a new one at ${DEVELOP} and paste it in Settings.`;
}

/**
 * Asks Freelancer.com whose `token` it is. A new token is kept only once it is accepted.
 * @param {string} token
 * @param {boolean} fresh true for a pasted token, false to recheck the saved one
 */
async function checkToken(token, fresh) {
  for (const b of [tokenSave, tokenCheck, tokenRemove]) b.disabled = true;
  tokenSave.setAttribute('aria-busy', 'true');
  say('info', 'Asking Freelancer.com whose token this is…');
  try {
    const account = await fetchSelf(token);
    const now = Date.now();
    stored = {
      token,
      savedAt: fresh || !stored ? now : stored.savedAt,
      account,
      checkedAt: now,
      problem: null,
    };
    keep(TOKEN_KEY, stored);
    tokenInput.value = '';
    showTokenError('');
    say(
      'success',
      `Freelancer.com accepted the token: you are ${account.username} (user ${String(account.id)}).`,
    );
  } catch (error) {
    const line = refusal(error);
    if (fresh) {
      showTokenError(line);
    } else if (stored) {
      stored = { ...stored, checkedAt: Date.now(), problem: line };
      keep(TOKEN_KEY, stored);
    }
    say('error', line);
  } finally {
    for (const b of [tokenSave, tokenCheck, tokenRemove]) b.disabled = false;
    tokenSave.removeAttribute('aria-busy');
    drawToken();
  }
}

tokenForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  const problem = tokenProblem(token);
  showTokenError(problem ?? '');
  if (problem) return;
  void checkToken(token, true);
});
tokenCheck.addEventListener('click', () => {
  if (stored) void checkToken(stored.token, false);
});
tokenRemove.addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'Remove the Freelancer token?',
    body: 'This browser forgets it. The token itself still works on Freelancer.com until it runs out; revoke it there to stop it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  stored = null;
  try {
    localStorage.removeItem(`radar.${TOKEN_KEY}`);
  } catch {
    // Nothing kept, nothing to remove.
  }
  drawToken();
  say('info', 'The token is removed from this browser.');
});

// ------------------------------------------------------------------ settings

const WEIGHTS = /** @type {const} */ (['skill', 'budget', 'fresh', 'competition']);

/**
 * The number boxes in settings: the setting, its lowest and highest value, whether it may
 * be left blank, and whether it must be whole.
 * @type {readonly (readonly ['pricePct' | 'defaultDays' | 'monthlyLimit' | 'usdToZar' | 'feePct' | 'devMinCompletion' | 'devMinReviews' | 'alertThreshold', number, number, boolean, boolean])[]}
 */
const NUMBER_SETTINGS = [
  ['pricePct', 1, 100, false, true],
  ['defaultDays', 1, 365, false, true],
  ['monthlyLimit', 1, 100_000, true, true],
  ['usdToZar', 0.01, 1000, true, false],
  ['feePct', 0, 100, true, false],
  ['devMinCompletion', 0, 100, false, false],
  ['devMinReviews', 0, 100_000, false, true],
  ['alertThreshold', 0, 100, false, true],
];

function fillSettings() {
  field(settingsForm, 'refreshMinutes').value = String(settings.refreshMinutes);
  /** @type {HTMLInputElement} */ (field(settingsForm, 'alertsOn')).checked =
    settings.alertsOn && canNotify() && Notification.permission === 'granted';
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
  if (target.name === 'usdToZar' || target.name === 'feePct') drawBids();
  if (target.name.startsWith('devMin')) drawDevelopers();
  if (target.name === 'alertThreshold') drawAlertState();
});

settingsForm.addEventListener('change', async (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target instanceof HTMLInputElement && target.name === 'alertsOn') {
    let on = target.checked;
    if (on && canNotify() && Notification.permission !== 'granted') {
      on = (await Notification.requestPermission()) === 'granted';
    }
    on = on && canNotify();
    target.checked = on;
    settings = { ...settings, alertsOn: on };
    keepSettings();
    drawAlertState();
    say(on ? 'success' : 'info', on ? 'Alerts are on.' : 'Alerts are off.');
    if (on) notifyNew();
    return;
  }
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
drawToken();
drawTemplates();
storageWarning.hidden = writeJson('probe', Date.now());
render();
drawBids();
drawDevelopers();
drawAlertState();
/** @type {string | null} */
let importedNote = null;
try {
  importedNote = sessionStorage.getItem(IMPORTED);
  sessionStorage.removeItem(IMPORTED);
} catch {
  // No session storage: nothing to say.
}
// The import's message is shown once the first read has said its own.
void refresh().then(() => {
  if (importedNote) say('success', importedNote);
});
