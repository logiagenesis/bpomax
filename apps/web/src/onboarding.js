// @ts-check
import { validateNewOrg } from '@arbitron/core';
import { ApiError, apiGet, apiSend } from './lib/api.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { clearSession, loginUrl, readSession, requireSession, signOut } from './lib/session.js';
import { runAction } from './lib/ui.js';

/**
 * Onboarding (ARB-400). Someone signed in but in no organisation creates one here
 * (`POST /v1/orgs`) and becomes its owner; a member sees the first steps, each ticked
 * from the org's own rows (`GET /v1/onboarding`), never by hand.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`onboarding is missing #${id}`);
  return element;
}

const status = byId('status');
const who = byId('who');
const form = /** @type {HTMLFormElement} */ (byId('create-org'));
const nameInput = /** @type {HTMLInputElement} */ (byId('name'));
const countryInput = /** @type {HTMLInputElement} */ (byId('countryCode'));
const create = /** @type {HTMLButtonElement} */ (byId('create'));
const stepsSection = byId('steps');
const summary = byId('steps-summary');
const list = byId('step-list');

/**
 * @typedef {{ key: string, title: string, detail: string, href: string, done: boolean, optional: boolean }} Step
 * @typedef {{ user: { email: string | null, fullName: string | null }, org: { name: string }, role: string, steps: Step[] }} Onboarding
 */

/** @param {unknown} error */
function backToLogin(error) {
  if (error instanceof ApiError && error.status === 401) {
    clearSession();
    location.replace(loginUrl('onboarding.html'));
    return true;
  }
  return false;
}

/** @param {Onboarding} data */
function renderSteps(data) {
  form.hidden = true;
  who.textContent = `${data.user.fullName ?? data.user.email ?? 'Signed in'} · ${data.role} · ${data.org.name}`;
  const left = data.steps.filter((step) => !step.done && !step.optional).length;
  summary.textContent =
    left === 0
      ? `${data.org.name} is set up. Everything below is done, apart from anything marked optional.`
      : `${data.org.name}: ${String(left)} of ${String(data.steps.filter((s) => !s.optional).length)} steps left.`;
  list.replaceChildren(
    ...data.steps.map((step) => {
      const item = document.createElement('li');
      item.className = 'stack';
      item.dataset.step = step.key;
      const heading = document.createElement('p');
      const badge = document.createElement('span');
      badge.className = `badge ${step.done ? 'badge--go' : 'badge--neutral'}`;
      badge.textContent = step.done ? 'Done' : step.optional ? 'Optional' : 'To do';
      const link = document.createElement('a');
      link.href = `./${step.href}`;
      link.textContent = step.title;
      heading.append(badge, ' ', link);
      const detail = document.createElement('p');
      detail.className = 'section-note';
      detail.textContent = step.detail;
      item.append(heading, detail);
      return item;
    }),
  );
  stepsSection.hidden = false;
}

async function load() {
  status.className = '';
  status.textContent = '';
  try {
    renderSteps(/** @type {Onboarding} */ (await apiGet('/v1/onboarding')));
  } catch (error) {
    if (backToLogin(error)) return;
    if (error instanceof ApiError && error.status === 403) {
      const session = readSession();
      who.textContent = session?.user?.email ?? 'Signed in';
      stepsSection.hidden = true;
      form.hidden = false;
      nameInput.focus();
      return;
    }
    status.className = 'alert alert--error';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const parsed = validateNewOrg({ name: nameInput.value, countryCode: countryInput.value });
  if (!parsed.ok) {
    showFieldErrors(form, parsed.errors);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  clearFieldErrors(form);
  void runAction(
    create,
    status,
    async () => {
      try {
        await apiSend('POST', '/v1/orgs', parsed.value);
      } catch (error) {
        if (backToLogin(error)) throw error;
        if (error instanceof ApiError && error.errors.length > 0)
          showFieldErrors(form, error.errors);
        throw error;
      }
      // Now a member: the sign-in is recorded the way the login page records it.
      await apiSend('POST', '/v1/sessions').catch(() => undefined);
      await load();
      return `${parsed.value.name} is created, and you are its owner.`;
    },
    { success: (message) => message },
  );
});

const signOutButton = /** @type {HTMLButtonElement} */ (byId('sign-out'));
signOutButton.addEventListener('click', async () => {
  signOutButton.disabled = true;
  await signOut();
  location.replace('./login.html');
});

if (requireSession()) void load();
