// @ts-check
import { parseTermsOfService } from '@arbitron/core';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { formatDate } from './lib/format.js';
import { authConfig, readSession, saveSession } from './lib/session.js';
import { runAction } from './lib/ui.js';

/**
 * Public sign-up (ARB-400). Email and password go to Supabase Auth —
 * `POST {SUPABASE_URL}/auth/v1/signup`, the request `supabase.auth.signUp()` makes, with
 * the body `{ email, password, data }` and the page to come back to as `redirect_to`
 * (https://supabase.com/docs/reference/javascript/auth-signup; the request itself is in
 * supabase-js, packages/core/auth-js/src/GoTrueClient.ts, `signUp`, and lib/fetch.ts,
 * `_request`). Supabase answers with a session when the project does not ask for email
 * confirmation, and with only the user when it does; the page handles both.
 *
 * Sign-up stays closed while the terms of service are pending (D-068): the accepted
 * version is sent as user metadata, so Supabase keeps a record of who accepted what.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`signup is missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('signup'));
const email = /** @type {HTMLInputElement} */ (byId('email'));
const password = /** @type {HTMLInputElement} */ (byId('password'));
const confirm = /** @type {HTMLInputElement} */ (byId('confirm'));
const terms = /** @type {HTMLInputElement} */ (byId('terms'));
const termsLabel = byId('terms-label');
const submit = /** @type {HTMLButtonElement} */ (byId('submit'));
const status = byId('status');

const config = authConfig();
/** @type {string | null} the version of the terms on show, once they are approved */
let termsVersion = null;

/** @param {string} message @param {'warning' | 'error'} [kind] */
function close(message, kind = 'warning') {
  for (const control of [email, password, confirm, terms, submit]) control.disabled = true;
  status.className = `alert alert--${kind}`;
  status.textContent = message;
}

async function loadTerms() {
  let raw;
  try {
    const response = await fetch('./terms.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    raw = await response.json();
  } catch {
    close(
      'The terms of service could not be loaded, so sign-up is closed. Reload to try again.',
      'error',
    );
    return;
  }
  const parsed = parseTermsOfService(raw);
  if (!parsed.ok) {
    close('The published terms of service are incomplete, so sign-up is closed.', 'error');
    return;
  }
  if (parsed.value.status === 'pending') {
    close(
      'Sign-up opens once the terms of service are published. Until then, an owner can add you to their organisation.',
    );
    return;
  }
  termsVersion = parsed.value.version;
  const link = document.createElement('a');
  link.href = './terms.html';
  link.textContent = 'terms of service';
  termsLabel.replaceChildren(
    'I accept the ',
    link,
    ` (version ${parsed.value.version}, approved ${formatDate(`${parsed.value.approvedOn}T12:00:00Z`)})`,
  );
}

if (!config) {
  close(
    'Sign-up is not set up on this build: the Supabase project (docs/02 B-06) is not configured.',
  );
} else if (readSession()) {
  location.replace('./onboarding.html');
} else {
  void loadTerms();
}

/**
 * Supabase Auth's error codes, as listed in supabase-js
 * (packages/core/auth-js/src/lib/error-codes.ts): the body carries `code` (API version
 * 2024-01-01 onwards) or `error_code`, and `msg`.
 * @param {number} statusCode
 * @param {any} body
 * @returns {{ field?: string, message: string }}
 */
function signupRefusal(statusCode, body) {
  const code =
    typeof body?.code === 'string'
      ? body.code
      : typeof body?.error_code === 'string'
        ? body.error_code
        : '';
  const detail = typeof body?.msg === 'string' ? body.msg : '';
  switch (code) {
    case 'user_already_exists':
    case 'email_exists':
      return { message: 'An account already uses this email address. Sign in instead.' };
    case 'weak_password':
      return {
        field: 'password',
        message: detail ? `is too weak: ${detail}` : 'is too weak for the sign-up service',
      };
    case 'email_address_invalid':
    case 'email_address_not_authorized':
      return { field: 'email', message: 'is not accepted by the sign-up service' };
    case 'over_email_send_rate_limit':
      return { message: 'Too many sign-up emails have been sent. Try again in a few minutes.' };
    case 'signup_disabled':
    case 'email_provider_disabled':
      return { message: 'Sign-up is switched off on this service.' };
    default:
      if (statusCode === 429) {
        return { message: 'Too many attempts. Wait a few minutes, then try again.' };
      }
      return {
        message: `The sign-up service answered ${String(statusCode)}${detail ? `: ${detail}` : ''}. Try again in a minute.`,
      };
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!config || !termsVersion) return;
  const version = termsVersion;

  /** @type {{ field: string, message: string }[]} */
  const errors = [];
  const address = email.value.trim();
  if (!address) errors.push({ field: 'email', message: 'is required' });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    errors.push({ field: 'email', message: 'must be an email address' });
  if (!password.value) errors.push({ field: 'password', message: 'is required' });
  if (!confirm.value) errors.push({ field: 'confirm', message: 'is required' });
  else if (confirm.value !== password.value)
    errors.push({ field: 'confirm', message: 'must match the password' });
  if (!terms.checked)
    errors.push({ field: 'terms', message: 'must be accepted to create an account' });
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
      const url = new URL(`${config.url}/auth/v1/signup`);
      url.searchParams.set('redirect_to', new URL('./login.html', location.href).href);
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { apikey: config.anonKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: address,
            password: password.value,
            data: { terms_version: version, terms_accepted_at: new Date().toISOString() },
          }),
        });
      } catch {
        throw new Error(
          'Could not reach the sign-up service. Check your connection and try again.',
        );
      }
      /** @type {any} */
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* not JSON */
      }
      if (!response.ok) {
        const refusal = signupRefusal(response.status, body);
        if (refusal.field) {
          showFieldErrors(form, [{ field: refusal.field, message: refusal.message }]);
          throw new Error('Some fields need attention. The first one has been selected.');
        }
        throw new Error(refusal.message);
      }
      password.value = '';
      confirm.value = '';
      // A session means the project signs people in straight away; no session means
      // Supabase has emailed a confirmation link (GoTrueClient.signUp's own remarks).
      if (
        typeof body?.access_token === 'string' &&
        typeof body?.refresh_token === 'string' &&
        body?.expires_in
      ) {
        saveSession(body);
        location.assign('./onboarding.html');
        return 'Account created. Opening the next step…';
      }
      for (const control of [email, password, confirm, terms, submit]) control.disabled = true;
      return `Check your email: a confirmation link is on its way to ${address}. Open it, then sign in to set up your organisation.`;
    },
    { success: (message) => message },
  ).then(() => {
    if (email.disabled) submit.disabled = true;
  });
});
