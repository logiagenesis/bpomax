// @ts-check
import { ApiError, apiSend } from './lib/api.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { authConfig, clearSession, readSession, saveSession } from './lib/session.js';
import { runAction } from './lib/ui.js';

/**
 * The login page (ARB-061). Email and password go to Supabase Auth —
 * `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`, the request
 * `supabase.auth.signInWithPassword()` makes:
 * https://supabase.com/docs/reference/javascript/auth-signinwithpassword — and the
 * session it answers is kept for the tab. The API is then told, so the audit log
 * records the sign-in, and the browser goes to the page it was asked for.
 *
 * Nothing here is a credential of the app: the project URL and anon key are the public
 * browser values (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`login is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('login'));
const email = /** @type {HTMLInputElement} */ (byId('email'));
const password = /** @type {HTMLInputElement} */ (byId('password'));
const submit = /** @type {HTMLButtonElement} */ (byId('submit'));
const status = byId('status');

/** Only a page of this app. Anything else goes to the dashboard. */
function nextPage() {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  return /^[a-z-]+\.html$/.test(next) && next !== 'login.html' ? next : 'dashboard.html';
}

const config = authConfig();

if (!config) {
  // Say so, rather than offer a form that can only fail.
  for (const control of [email, password, submit]) control.disabled = true;
  status.className = 'alert alert--warning';
  status.textContent =
    'Sign-in is not set up on this build: the Supabase project (docs/02 B-06) is not configured.';
} else if (readSession()) {
  location.replace(`./${nextPage()}`);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!config) return;

  /** @type {{ field: string, message: string }[]} */
  const errors = [];
  const address = email.value.trim();
  if (!address) errors.push({ field: 'email', message: 'is required' });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    errors.push({ field: 'email', message: 'must be an email address' });
  if (!password.value) errors.push({ field: 'password', message: 'is required' });
  if (errors.length > 0) {
    showFieldErrors(form, errors);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  clearFieldErrors(form);

  void runAction(
    submit,
    status,
    async () => {
      let response;
      try {
        response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { apikey: config.anonKey, 'content-type': 'application/json' },
          body: JSON.stringify({ email: address, password: password.value }),
        });
      } catch {
        throw new Error(
          'Could not reach the sign-in service. Check your connection and try again.',
        );
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new Error('Email or password is wrong. Check both and try again.');
      }
      if (!response.ok) {
        throw new Error(
          `The sign-in service answered ${String(response.status)}. Try again in a minute.`,
        );
      }
      const session = await response.json();
      if (typeof session?.access_token !== 'string') {
        throw new Error('The sign-in service answered without a session. Try again.');
      }
      saveSession(session);

      try {
        await apiSend('POST', '/v1/sessions');
      } catch (error) {
        clearSession();
        if (error instanceof ApiError && error.status === 403) {
          throw new Error(
            'Signed in, but this account is not a member of an organisation. Ask an owner to add you.',
          );
        }
        throw error;
      }
      password.value = '';
      location.assign(`./${nextPage()}`);
      return 'Signed in. Opening the next page…';
    },
    { success: (message) => message },
  );
});
