// @ts-check
import { formatDateTime, formatMoney, formatPercent } from './lib/format.js';
import { confirmAction, runAction } from './lib/ui.js';

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`style guide is missing #${id}`);
  return element;
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Colour swatches, read from the tokens so the page cannot disagree with them.
const SWATCHES = [
  'primary',
  'bg',
  'surface',
  'surface-raised',
  'border',
  'text',
  'text-muted',
  'success',
  'warning',
  'danger',
];
const styles = getComputedStyle(document.documentElement);
const swatches = byId('swatches');
for (const name of SWATCHES) {
  const value = styles.getPropertyValue(`--color-${name}`).trim();
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div style="height:3rem;border-radius:var(--radius);border:1px solid var(--color-border);background:var(--color-${name})"></div>
    <p class="stat__label" style="margin-top:var(--space-2)">--color-${name}</p>
    <p class="stat__note"><code>${value}</code></p>`;
  swatches.append(card);
}

// Formats
for (const element of document.querySelectorAll('[data-money]')) {
  const el = /** @type {HTMLElement} */ (element);
  el.textContent = formatMoney(Number(el.dataset.money), el.dataset.currency ?? 'ZAR');
}
for (const element of document.querySelectorAll('[data-percent]')) {
  const el = /** @type {HTMLElement} */ (element);
  el.textContent = formatPercent(Number(el.dataset.percent));
}
for (const element of document.querySelectorAll('[data-datetime]')) {
  const el = /** @type {HTMLElement} */ (element);
  el.textContent = formatDateTime(el.dataset.datetime ?? '');
}

// Buttons
const buttonStatus = byId('button-status');
const saveButton = /** @type {HTMLButtonElement} */ (byId('btn-save'));
const failButton = /** @type {HTMLButtonElement} */ (byId('btn-fail'));
const deleteButton = /** @type {HTMLButtonElement} */ (byId('btn-delete'));
const resetButton = /** @type {HTMLButtonElement} */ (byId('btn-reset'));

saveButton.addEventListener('click', () => {
  void runAction(saveButton, buttonStatus, () => wait(400), {
    success: 'Saved. This is an example: nothing was stored.',
  });
});

failButton.addEventListener('click', () => {
  void runAction(
    failButton,
    buttonStatus,
    async () => {
      await wait(400);
      throw new Error('Could not save: the example server refused the request. Try again.');
    },
    { success: '' },
  );
});

deleteButton.addEventListener('click', async () => {
  const confirmed = await confirmAction({
    title: 'Delete the example?',
    body: 'This is the confirmation every destructive action uses. Nothing is deleted here.',
    confirmLabel: 'Delete',
    danger: true,
  });
  buttonStatus.className = `alert ${confirmed ? 'alert--success' : 'alert--info'}`;
  buttonStatus.textContent = confirmed
    ? 'Deleted. This is an example: nothing was removed.'
    : 'Cancelled. Nothing was deleted.';
});

// Form
const form = /** @type {HTMLFormElement} */ (byId('example-form'));
const formStatus = byId('form-status');

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

resetButton.addEventListener('click', () => {
  form.reset();
  setError('scanner-name', '');
  setError('daily-cap', '');
  formStatus.className = '';
  formStatus.textContent = '';
  buttonStatus.className = 'alert alert--info';
  buttonStatus.textContent = 'The form has been reset.';
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  const cap = String(data.get('dailyCap') ?? '').trim();

  // The same rules the API applies to a scanner (packages/core/src/scanners.ts).
  setError('scanner-name', name === '' ? 'Enter a name for the scanner.' : '');
  setError(
    'daily-cap',
    /^\d+$/.test(cap) && Number(cap) >= 1 && Number(cap) <= 100
      ? ''
      : 'Enter a whole number from 1 to 100.',
  );

  const firstInvalid = form.querySelector('[aria-invalid="true"]');
  if (firstInvalid instanceof HTMLElement) {
    firstInvalid.focus();
    formStatus.className = 'alert alert--error';
    formStatus.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  formStatus.className = 'alert alert--success';
  formStatus.textContent = `The form is valid: "${name}", up to ${cap} a day. Nothing was saved.`;
});

// Live-mode switch: confirmation to turn on, none to turn off (turning off is always safe).
const liveSwitch = /** @type {HTMLInputElement} */ (byId('live-switch'));
const liveBadge = byId('live-badge');
function showLiveState() {
  liveBadge.className = `badge ${liveSwitch.checked ? 'badge--live' : 'badge--neutral'}`;
  liveBadge.textContent = liveSwitch.checked ? 'Live' : 'Sandbox';
}
liveSwitch.addEventListener('change', async () => {
  if (liveSwitch.checked) {
    liveSwitch.checked = false;
    const confirmed = await confirmAction({
      title: 'Turn live mode on?',
      body: 'Approved bids and messages would be sent to real clients. On this page it is an example only.',
      confirmLabel: 'Turn live mode on',
      danger: true,
    });
    liveSwitch.checked = confirmed;
  }
  showLiveState();
});
showLiveState();
