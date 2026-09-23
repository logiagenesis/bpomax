// @ts-check
import {
  canChangeSettings,
  canWrite,
  checkAutoSendGuardrails,
  parseFeeTable,
  validateMarginRules,
  validatePlanRecord,
  validateScanner,
} from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import {
  clearFieldErrors,
  minorToRandInput,
  parseRandToMinor,
  showFieldErrors,
} from './lib/forms.js';
import { formatDate, formatDateTime, formatMoney } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { confirmAction, runAction } from './lib/ui.js';

/**
 * Settings (ARB-061, docs/01 section I). Each section is its own form against its own
 * route; the rules a form checks before sending are the same functions the API runs
 * (`@arbitron/core`), so a value refused here would be refused there and the reverse.
 *
 * What a role may not change is disabled with the reason in its title (D-013); RLS is
 * what actually refuses it.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`settings is missing #${id}`);
  return element;
}

/** @param {unknown} e */
function bail(e) {
  if (backToLoginOn401(e)) return true;
  throw e;
}

const status = byId('status');
const reload = /** @type {HTMLButtonElement} */ (byId('reload'));

/** @type {'owner' | 'operator' | 'viewer'} */
let role = 'viewer';

// ---------------------------------------------------------------- live mode
const liveSwitch = /** @type {HTMLInputElement} */ (byId('live-switch'));
const liveBadge = byId('live-badge');
const envLive = byId('env-live');
const liveBlockers = byId('live-blockers');
const liveBlockersList = byId('live-blockers-list');

/**
 * @param {{ liveMode: boolean }} settings
 * @param {string[]} blockers
 * @param {boolean} environmentLiveMode
 */
function renderLive(settings, blockers, environmentLiveMode) {
  envLive.className = `badge badge--${environmentLiveMode ? 'live' : 'neutral'}`;
  envLive.textContent = environmentLiveMode ? 'On (LIVE_MODE=true)' : 'Off (LIVE_MODE=false)';
  liveSwitch.checked = settings.liveMode;
  liveBadge.className = `badge badge--${settings.liveMode ? 'live' : 'neutral'}`;
  liveBadge.textContent = settings.liveMode ? 'Live' : 'Sandbox';
  liveBlockersList.replaceChildren(
    ...blockers.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }),
  );
  liveBlockers.hidden = blockers.length === 0 || settings.liveMode;
  const canSwitch = canChangeSettings(role) && (settings.liveMode || blockers.length === 0);
  liveSwitch.disabled = !canSwitch;
  liveSwitch.title = !canChangeSettings(role)
    ? 'Only an owner can switch live mode.'
    : blockers.length > 0 && !settings.liveMode
      ? 'Set every rule above first.'
      : '';
}

liveSwitch.addEventListener('change', async () => {
  const wantLive = liveSwitch.checked;
  liveSwitch.checked = !wantLive; // Only the API's answer moves the switch.
  const ok = await confirmAction({
    title: wantLive ? 'Switch live mode on?' : 'Switch live mode off?',
    body: wantLive
      ? 'With the server switch also on, approved bids and messages will reach real marketplaces and real clients. This is logged with your name.'
      : 'Nothing will leave the system until it is switched on again. Approved items are kept.',
    confirmLabel: wantLive ? 'Go live' : 'Switch off',
    danger: wantLive,
  });
  if (!ok) return;
  const button = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ (liveSwitch));
  await runAction(
    button,
    status,
    async () => {
      try {
        const body =
          /** @type {{ settings: { liveMode: boolean }, liveModeBlockers: string[] }} */ (
            await apiSend('POST', '/v1/settings/live-mode', { live: wantLive })
          );
        renderLive(
          body.settings,
          body.liveModeBlockers,
          envLive.textContent?.startsWith('On') ?? false,
        );
        return body.settings.liveMode;
      } catch (e) {
        bail(e);
        return undefined;
      }
    },
    {
      success: (live) =>
        live ? 'Live mode is on for this organisation.' : 'Live mode is off. Nothing leaves.',
    },
  );
});

// ------------------------------------------------------------- margin rules
const rulesForm = /** @type {HTMLFormElement} */ (byId('rules-form'));
const rulesSave = /** @type {HTMLButtonElement} */ (byId('rules-save'));

/** @param {{ minMarginPct: string | null, minMarginZarMinor: string | null, fxBufferPct: string | null, vatPct: string, retentionDays: number | null }} s */
function renderRules(s) {
  /** @param {string} id @param {string} value */
  const set = (id, value) => {
    /** @type {HTMLInputElement} */ (byId(id)).value = value;
  };
  set('minMarginPct', s.minMarginPct ?? '');
  set('minMarginZarMinor', minorToRandInput(s.minMarginZarMinor));
  set('fxBufferPct', s.fxBufferPct ?? '');
  set('vatPct', s.vatPct);
  set('retentionDays', s.retentionDays === null ? '' : String(s.retentionDays));
  const allowed = canChangeSettings(role);
  for (const control of rulesForm.querySelectorAll('input, button')) {
    /** @type {HTMLInputElement | HTMLButtonElement} */ (control).disabled = !allowed;
    if (!allowed) control.setAttribute('title', 'Only an owner can change margin rules.');
  }
}

rulesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(rulesForm);
  const rand = String(data.get('minMarginZarMinor') ?? '').trim();
  const minor = rand === '' ? '' : parseRandToMinor(rand);
  /** @type {Record<string, unknown>} */
  const input = {
    minMarginPct: String(data.get('minMarginPct') ?? '')
      .trim()
      .replace(',', '.'),
    minMarginZarMinor: minor === null ? 'not an amount' : minor === '' ? '' : Number(minor),
    fxBufferPct: String(data.get('fxBufferPct') ?? '')
      .trim()
      .replace(',', '.'),
    vatPct: String(data.get('vatPct') ?? '')
      .trim()
      .replace(',', '.'),
    retentionDays: String(data.get('retentionDays') ?? '').trim(),
  };
  const validated = validateMarginRules(input);
  if (!validated.ok) {
    showFieldErrors(rulesForm, validated.errors);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  clearFieldErrors(rulesForm);
  await runAction(
    rulesSave,
    status,
    async () => {
      try {
        const body = /** @type {{ settings: any, liveModeBlockers: string[] }} */ (
          await apiSend('PATCH', '/v1/settings', input)
        );
        renderRules(body.settings);
        renderLive(
          body.settings,
          body.liveModeBlockers,
          envLive.textContent?.startsWith('On') ?? false,
        );
      } catch (e) {
        if (e instanceof Error && 'errors' in e && Array.isArray(e.errors) && e.errors.length > 0) {
          showFieldErrors(rulesForm, e.errors);
        }
        bail(e);
      }
    },
    { success: 'Margin rules saved.' },
  );
});

// ---------------------------------------------------------------- fee table
const feeForm = /** @type {HTMLFormElement} */ (byId('fee-form'));
const feeRows = byId('fee-rows');
const feeAdd = /** @type {HTMLButtonElement} */ (byId('fee-add'));
const feeSave = /** @type {HTMLButtonElement} */ (byId('fee-save'));
const feeTableError = byId('fee-table-error');

/**
 * @param {string} id
 * @param {string} labelText
 * @param {HTMLInputElement | HTMLSelectElement} control
 */
function feeField(id, labelText, control) {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.className = 'field__label';
  label.htmlFor = id;
  label.textContent = labelText;
  control.id = id;
  control.setAttribute('aria-describedby', `${id}-error`);
  const error = document.createElement('p');
  error.className = 'field__error';
  error.id = `${id}-error`;
  error.hidden = true;
  field.append(label, control, error);
  return field;
}

/**
 * @param {string[]} options
 * @param {string} value
 */
function select(options, value) {
  const control = document.createElement('select');
  control.className = 'select';
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option;
    element.textContent = option;
    control.append(element);
  }
  control.value = value;
  return control;
}

/**
 * @param {string} value
 * @param {string} [type]
 */
function input(value, type = 'text') {
  const control = document.createElement('input');
  control.className = 'input';
  control.type = type;
  control.value = value;
  return control;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {number} index
 */
function feeRow(rule, index) {
  const row = document.createElement('div');
  row.className = 'fee-row';
  row.dataset.index = String(index);
  const minMinor = rule.min_minor;
  row.append(
    feeField(
      `fee-${index}-platform`,
      'Platform',
      select(['freelancer', 'upwork', 'fiverr'], String(rule.platform ?? 'freelancer')),
    ),
    feeField(
      `fee-${index}-project_type`,
      'Project type',
      select(['fixed', 'hourly'], String(rule.project_type ?? 'fixed')),
    ),
    feeField(
      `fee-${index}-side`,
      'Side',
      select(['freelancer', 'employer'], String(rule.side ?? 'freelancer')),
    ),
    feeField(
      `fee-${index}-percent`,
      'Fee (%)',
      input(rule.percent === undefined ? '' : String(rule.percent)),
    ),
    feeField(
      `fee-${index}-min_minor`,
      'Minimum fee (amount)',
      input(typeof minMinor === 'number' ? minorToRandInput(minMinor) : ''),
    ),
    feeField(
      `fee-${index}-min_currency`,
      'Minimum fee currency',
      input(String(rule.min_currency ?? '')),
    ),
    feeField(
      `fee-${index}-source_url`,
      'Official fee page (URL)',
      input(String(rule.source_url ?? ''), 'url'),
    ),
    feeField(`fee-${index}-read_on`, 'Read on', input(String(rule.read_on ?? ''), 'date')),
  );
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn--ghost';
  remove.textContent = 'Remove rule';
  remove.setAttribute('aria-label', `Remove fee rule ${String(index + 1)}`);
  remove.addEventListener('click', () => {
    row.remove();
    renumberFeeRows();
  });
  row.append(remove);
  return row;
}

function renumberFeeRows() {
  const rows = [...feeRows.children];
  const rules = rows.map((row) => readFeeRow(/** @type {HTMLElement} */ (row)));
  feeRows.replaceChildren(...rules.map((rule, index) => feeRow(rule, index)));
  applyFeeRole();
}

/** @param {HTMLElement} row */
function readFeeRow(row) {
  const index = row.dataset.index ?? '0';
  /** @param {string} name */
  const value = (name) =>
    /** @type {HTMLInputElement | HTMLSelectElement} */ (
      row.querySelector(`#fee-${index}-${name}`)
    ).value.trim();
  const percentText = value('percent').replace(',', '.');
  const minText = value('min_minor');
  const minMinor = minText === '' ? null : parseRandToMinor(minText);
  return {
    platform: value('platform'),
    project_type: value('project_type'),
    side: value('side'),
    percent: percentText === '' ? undefined : Number(percentText),
    min_minor: minText === '' ? null : minMinor === null ? -1 : Number(minMinor),
    min_currency: value('min_currency') === '' ? null : value('min_currency').toUpperCase(),
    source_url: value('source_url'),
    read_on: value('read_on'),
  };
}

function applyFeeRole() {
  const allowed = canChangeSettings(role);
  for (const control of feeForm.querySelectorAll('input, select, button')) {
    /** @type {HTMLInputElement} */ (control).disabled = !allowed;
    if (!allowed) control.setAttribute('title', 'Only an owner can change the fee table.');
  }
}

/** @param {unknown[]} table */
function renderFees(table) {
  feeRows.replaceChildren(
    ...table.map((rule, index) => feeRow(/** @type {Record<string, unknown>} */ (rule), index)),
  );
  applyFeeRole();
}

/** @param {{ field: string, message: string }[]} errors */
function showFeeErrors(errors) {
  clearFieldErrors(feeForm);
  feeTableError.hidden = true;
  let first = null;
  for (const error of errors) {
    const match = /^(?:feeTable)?\[(\d+)\](?:\.(\w+))?$/.exec(error.field);
    const message = `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    if (!match) {
      feeTableError.textContent = message;
      feeTableError.hidden = false;
      continue;
    }
    const slotId = match[2] ? `fee-${match[1]}-${match[2]}-error` : null;
    const slot = slotId ? document.getElementById(slotId) : null;
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
      const control = document.getElementById(`fee-${match[1]}-${match[2]}`);
      control?.setAttribute('aria-invalid', 'true');
      first ??= control;
    } else {
      feeTableError.textContent = `Rule ${String(Number(match[1]) + 1)}: ${message}`;
      feeTableError.hidden = false;
    }
  }
  first?.focus();
}

feeAdd.addEventListener('click', () => {
  feeRows.append(
    feeRow(
      { read_on: new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10) },
      feeRows.children.length,
    ),
  );
  applyFeeRole();
  /** @type {HTMLElement | null} */ (feeRows.lastElementChild?.querySelector('select'))?.focus();
});

feeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const table = [...feeRows.children].map((row) => readFeeRow(/** @type {HTMLElement} */ (row)));
  const parsed = parseFeeTable(table);
  if (!parsed.ok) {
    showFeeErrors(parsed.errors);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  clearFieldErrors(feeForm);
  feeTableError.hidden = true;
  await runAction(
    feeSave,
    status,
    async () => {
      try {
        const body = /** @type {{ settings: any, liveModeBlockers: string[] }} */ (
          await apiSend('PATCH', '/v1/settings', { feeTable: table })
        );
        renderFees(body.settings.feeTable);
        renderLive(
          body.settings,
          body.liveModeBlockers,
          envLive.textContent?.startsWith('On') ?? false,
        );
        return table.length;
      } catch (e) {
        if (e instanceof Error && 'errors' in e && Array.isArray(e.errors) && e.errors.length > 0)
          showFeeErrors(e.errors);
        bail(e);
        return 0;
      }
    },
    { success: (n) => `Fee table saved with ${String(n)} rule${n === 1 ? '' : 's'}.` },
  );
});

// ----------------------------------------------------------------- accounts
const accounts = byId('accounts');

/**
 * @param {{ id: string, platform: string, externalUserId: string, status: string, lastSyncAt: string | null,
 *           planName: string | null, monthlyBidAllowance: number | null, planRecordedOn: string | null }} account
 */
function accountCard(account) {
  const form = document.createElement('form');
  form.className = 'stack';
  form.noValidate = true;
  form.setAttribute('aria-labelledby', `account-${account.id}-title`);
  const title = document.createElement('h3');
  title.id = `account-${account.id}-title`;
  title.textContent = `${account.platform} · ${account.externalUserId}`;
  const meta = document.createElement('p');
  meta.className = 'section-note';
  meta.textContent = `Status ${account.status}${account.lastSyncAt ? `, last synced ${formatDateTime(account.lastSyncAt)}` : ''}${
    account.planRecordedOn
      ? `. Plan recorded ${formatDate(`${account.planRecordedOn}T12:00:00Z`)}`
      : '. Plan not recorded yet (docs/02 T-03)'
  }.`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  const plan = input(account.planName ?? '');
  plan.name = 'planName';
  const allowance = input(
    account.monthlyBidAllowance === null ? '' : String(account.monthlyBidAllowance),
  );
  allowance.name = 'monthlyBidAllowance';
  allowance.inputMode = 'numeric';
  grid.append(
    feeField(`${account.id}-planName`, 'Plan name', plan),
    feeField(`${account.id}-monthlyBidAllowance`, 'Monthly bid allowance', allowance),
  );
  const actions = document.createElement('div');
  actions.className = 'cluster';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save plan';
  save.setAttribute('aria-label', `Save plan for ${account.platform}`);
  actions.append(save);
  form.append(title, meta, grid, actions);
  const allowed = canWrite(role);
  for (const control of [plan, allowance, save]) {
    control.disabled = !allowed;
    if (!allowed) control.title = 'Your role can view accounts but not change them.';
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validated = validatePlanRecord({
      planName: plan.value,
      monthlyBidAllowance: allowance.value.trim(),
    });
    if (!validated.ok) {
      showFieldErrors(form, validated.errors, `${account.id}-`);
      status.className = 'alert alert--error';
      status.textContent = 'Some fields need attention. The first one has been selected.';
      return;
    }
    clearFieldErrors(form);
    await runAction(
      save,
      status,
      async () => {
        try {
          const body = /** @type {{ account: typeof account }} */ (
            await apiSend('PATCH', `/v1/platform-accounts/${account.id}`, validated.value)
          );
          form.replaceWith(accountCard(body.account));
        } catch (e) {
          bail(e);
        }
      },
      { success: `Plan saved for ${account.platform}.` },
    );
  });
  return form;
}

// ----------------------------------------------------------------- scanners
/**
 * @typedef {{ id: string, name: string, platform: string, filters: { keywords?: string[] }, poll_interval_seconds: number,
 *             active: boolean, auto_send: boolean, min_score: number | null, daily_cap: number }} Scanner
 */
const scannerForm = /** @type {HTMLFormElement} */ (byId('scanner-form'));
const scannerRows = byId('scanner-rows');
const scannerTable = byId('scanner-table');
const scannerEmpty = byId('scanner-empty');
const scannerSave = /** @type {HTMLButtonElement} */ (byId('scanner-save'));
const scannerCancel = /** @type {HTMLButtonElement} */ (byId('scanner-cancel'));
const scannerHeading = byId('scanner-form-heading');
/** @type {string | null} */
let editingScanner = null;
let orgId = '';

/** @param {Scanner | null} scanner */
function fillScannerForm(scanner) {
  editingScanner = scanner?.id ?? null;
  scannerHeading.textContent = scanner ? `Edit “${scanner.name}”` : 'Add a scanner';
  scannerSave.textContent = scanner ? 'Save scanner' : 'Add scanner';
  scannerCancel.hidden = !scanner;
  /** @type {HTMLInputElement} */ (byId('scanner-name')).value = scanner?.name ?? '';
  /** @type {HTMLSelectElement} */ (byId('scanner-platform')).value =
    scanner?.platform ?? 'freelancer';
  /** @type {HTMLInputElement} */ (byId('scanner-filters')).value = (
    scanner?.filters.keywords ?? []
  ).join(', ');
  /** @type {HTMLInputElement} */ (byId('scanner-pollIntervalSeconds')).value = String(
    scanner?.poll_interval_seconds ?? 120,
  );
  /** @type {HTMLInputElement} */ (byId('scanner-dailyCap')).value = String(
    scanner?.daily_cap ?? 0,
  );
  /** @type {HTMLInputElement} */ (byId('scanner-minScore')).value =
    scanner?.min_score === null || scanner?.min_score === undefined
      ? ''
      : String(scanner.min_score);
  /** @type {HTMLInputElement} */ (byId('scanner-active')).checked = scanner?.active ?? true;
  /** @type {HTMLInputElement} */ (byId('scanner-autoSend')).checked = scanner?.auto_send ?? false;
  clearFieldErrors(scannerForm);
}

/** @param {Scanner[]} scanners */
function renderScanners(scanners) {
  scannerRows.replaceChildren();
  const allowed = canWrite(role);
  for (const scanner of scanners) {
    const tr = document.createElement('tr');
    const cells = [
      scanner.name,
      scanner.platform,
      `${String(scanner.poll_interval_seconds)} s`,
      scanner.active ? 'Yes' : 'No',
      scanner.auto_send
        ? `On, cap ${String(scanner.daily_cap)}/day, score ≥ ${String(scanner.min_score ?? '?')}`
        : 'Off',
    ].map((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    });
    const actions = document.createElement('td');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn--secondary';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${scanner.name}`);
    edit.addEventListener('click', () => {
      fillScannerForm(scanner);
      byId('scanner-name').focus();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--danger';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${scanner.name}`);
    remove.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: `Delete “${scanner.name}”?`,
        body: 'The scanner stops running and is removed. Jobs it already found are kept.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const done = await runAction(
        remove,
        status,
        async () => {
          try {
            await apiSend('DELETE', `/v1/scanners/${scanner.id}`);
            return true;
          } catch (e) {
            bail(e);
            return false;
          }
        },
        { success: `Deleted “${scanner.name}”.` },
      );
      if (done) await loadScanners();
    });
    for (const button of [edit, remove]) {
      button.disabled = !allowed;
      if (!allowed) button.title = 'Your role can view scanners but not change them.';
    }
    actions.append(edit, remove);
    tr.append(...cells, actions);
    scannerRows.append(tr);
  }
  scannerTable.hidden = scanners.length === 0;
  scannerEmpty.hidden = scanners.length !== 0;
  for (const control of scannerForm.querySelectorAll('input, select, button')) {
    /** @type {HTMLInputElement} */ (control).disabled = !allowed;
    if (!allowed) control.setAttribute('title', 'Your role can view scanners but not change them.');
  }
}

async function loadScanners() {
  try {
    const body = /** @type {{ scanners: Scanner[] }} */ (await apiGet('/v1/scanners'));
    renderScanners(body.scanners);
  } catch (e) {
    bail(e);
  }
}

scannerCancel.addEventListener('click', () => {
  fillScannerForm(null);
  byId('scanner-name').focus();
});

scannerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(scannerForm);
  /** @param {string} name */
  const number = (name) => {
    const text = String(data.get(name) ?? '').trim();
    return text === '' ? undefined : Number(text);
  };
  const keywords = String(data.get('keywords') ?? '')
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);
  const minScore = number('minScore');
  const input = {
    name: String(data.get('name') ?? ''),
    platform: String(data.get('platform') ?? 'freelancer'),
    filters: keywords.length > 0 ? { keywords } : {},
    pollIntervalSeconds: number('pollIntervalSeconds'),
    active: data.get('active') === 'on',
    autoSend: data.get('autoSend') === 'on',
    minScore: minScore === undefined ? null : minScore,
    dailyCap: number('dailyCap') ?? 0,
  };
  const validated = validateScanner(input);
  // The same two checks the API makes, in the same order (ARB-021, D-018).
  const errors = validated.ok ? checkAutoSendGuardrails(input) : validated.errors;
  if (errors.length > 0) {
    showFieldErrors(scannerForm, errors, 'scanner-');
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  clearFieldErrors(scannerForm);
  const editing = editingScanner;
  const done = await runAction(
    scannerSave,
    status,
    async () => {
      try {
        if (editing) await apiSend('PATCH', `/v1/scanners/${editing}`, input);
        else await apiSend('POST', '/v1/scanners', { orgId, ...input });
        return true;
      } catch (e) {
        if (e instanceof Error && 'errors' in e && Array.isArray(e.errors) && e.errors.length > 0) {
          showFieldErrors(scannerForm, e.errors, 'scanner-');
        }
        bail(e);
        return false;
      }
    },
    { success: editing ? `Saved “${input.name.trim()}”.` : `Added “${input.name.trim()}”.` },
  );
  if (done) {
    fillScannerForm(null);
    await loadScanners();
  }
});

// ------------------------------------------------------ market price bands
const bandsTable = byId('bands-table');
const bandsRows = byId('bands-rows');
const bandsEmpty = byId('bands-empty');
const bandsCategories = byId('bands-categories');

/** How each `price_band_source` reads on the page (0004). */
const SOURCE_LABEL = /** @type {Record<string, string>} */ ({
  seed: 'Seed',
  marketplace_sample: 'Marketplace sample',
  owner_csv: 'Owner CSV',
  completed_projects: 'Completed projects',
});

/**
 * @typedef {{ id: string, categorySlug: string, categoryName: string, currency: string,
 *   p25Minor: string, p50Minor: string, p75Minor: string, sampleSize: number,
 *   source: string, sampledAt: string }} Band
 */

/**
 * Seed rows carry the dashed "Seed" badge (ARB-013): a seed figure is an estimate, and
 * the page must never let it pass for an observed price.
 * @param {Band} band
 */
function sourceBadge(band) {
  const badge = document.createElement('span');
  const seed = band.source === 'seed';
  badge.className = `badge badge--${seed ? 'seed' : 'neutral'}`;
  badge.textContent = SOURCE_LABEL[band.source] ?? band.source;
  if (seed) badge.title = 'Seed figure, not observed data';
  return badge;
}

/** @param {{ categories: number, bands: Band[] }} body */
function renderBands(body) {
  bandsCategories.textContent = `${body.categories} service categories.`;
  bandsRows.replaceChildren(
    ...body.bands.map((band) => {
      const tr = document.createElement('tr');
      /** @param {string | Node} content @param {string} [className] */
      const cell = (content, className) => {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.append(content);
        return td;
      };
      tr.append(
        cell(band.categoryName),
        cell(band.currency),
        cell(formatMoney(BigInt(band.p25Minor), band.currency), 'num'),
        cell(formatMoney(BigInt(band.p50Minor), band.currency), 'num'),
        cell(formatMoney(BigInt(band.p75Minor), band.currency), 'num'),
        cell(String(band.sampleSize), 'num'),
        cell(sourceBadge(band)),
        cell(formatDate(band.sampledAt)),
      );
      return tr;
    }),
  );
  bandsTable.hidden = body.bands.length === 0;
  bandsEmpty.hidden = body.bands.length !== 0;
}

async function loadBands() {
  try {
    renderBands(
      /** @type {{ categories: number, bands: Band[] }} */ (await apiGet('/v1/price-bands')),
    );
  } catch (e) {
    bail(e);
  }
}

// ----------------------------------------------------------------- telegram
const linkCode = /** @type {HTMLButtonElement} */ (byId('link-code'));
const linkCodeOut = byId('link-code-out');
const telegramState = byId('telegram-state');

linkCode.addEventListener('click', () => {
  void runAction(
    linkCode,
    status,
    async () => {
      try {
        const body = /** @type {{ code: string, expiresAt: string }} */ (
          await apiSend('POST', '/v1/telegram/link-codes')
        );
        linkCodeOut.textContent = `Send /start ${body.code} to the bot before ${formatDateTime(body.expiresAt)}.`;
        return body.code;
      } catch (e) {
        bail(e);
        return '';
      }
    },
    { success: 'Link code created. It works once and expires in ten minutes.' },
  );
});

// --------------------------------------------------------------------- load
async function load() {
  await runAction(
    reload,
    status,
    async () => {
      try {
        const body = /** @type {any} */ (await apiGet('/v1/settings'));
        role = body.role;
        renderLive(body.settings, body.liveModeBlockers, body.environmentLiveMode);
        renderRules(body.settings);
        renderFees(body.settings.feeTable);
        accounts.replaceChildren(...body.accounts.map(accountCard));
        if (body.accounts.length === 0) {
          const none = document.createElement('p');
          none.className = 'section-note';
          none.textContent = 'No platform account is connected.';
          accounts.append(none);
        }
        telegramState.textContent = body.telegramLinked
          ? 'Your Telegram chat is linked. A new code moves the link to the chat that sends it.'
          : 'Your Telegram chat is not linked yet. Create a code and send it to the bot as /start <code>.';
        linkCode.disabled = !canWrite(role);
        if (!canWrite(role)) linkCode.title = 'Your role cannot link Telegram.';
        await loadScanners();
        await loadBands();
      } catch (e) {
        bail(e);
      }
    },
    { success: 'Settings loaded.' },
  );
}

reload.addEventListener('click', () => void load());

void mountShell().then((me) => {
  if (!me) return;
  role = me.role;
  orgId = me.org.id;
  void load();
});
