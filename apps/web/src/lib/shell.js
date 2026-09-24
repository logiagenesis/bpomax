// @ts-check
import { ApiError, apiGet } from './api.js';
import { clearSession, loginUrl, requireSession, signOut } from './session.js';

/**
 * What every signed-in page does first (ARB-061): check there is a session, mark the
 * current page in the navigation, say who is signed in, and wire the sign-out button.
 *
 * Returns the person's membership from `GET /v1/me`, so a page can grey out what their
 * role may not do (D-013). A 401 from that call means the token is no longer good, and
 * the page goes back to login rather than showing a shell with nothing in it; a 403
 * means the person is in no organisation yet, and the page goes to onboarding.
 *
 * @typedef {{ user: { id: string, email: string | null, fullName: string | null, telegramLinked: boolean },
 *             org: { id: string, name: string, baseCurrency: string },
 *             role: 'owner' | 'operator' | 'viewer' }} Me
 * @returns {Promise<Me | null>}
 */
export async function mountShell() {
  if (!requireSession()) return null;

  const page = location.pathname.split('/').pop() || 'index.html';
  for (const link of document.querySelectorAll('.nav a')) {
    const href = link.getAttribute('href') ?? '';
    if (href.replace(/^\.\//, '') === page) link.setAttribute('aria-current', 'page');
  }

  const signOutButton = document.getElementById('sign-out');
  if (signOutButton instanceof HTMLButtonElement) {
    signOutButton.addEventListener('click', async () => {
      signOutButton.disabled = true;
      await signOut();
      location.replace('./login.html');
    });
  }

  const who = document.getElementById('who');
  try {
    const me = /** @type {Me} */ (await apiGet('/v1/me'));
    if (who) {
      who.textContent = `${me.user.fullName ?? me.user.email ?? 'Signed in'} · ${me.role} · ${me.org.name}`;
    }
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearSession();
      location.replace(loginUrl());
      return null;
    }
    // Signed in but in no organisation (ARB-400): onboarding creates one.
    if (error instanceof ApiError && error.status === 403) {
      location.replace('./onboarding.html');
      return null;
    }
    if (who) who.textContent = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/**
 * When a request comes back 401 mid-page, the session is over: back to login.
 * @param {unknown} error
 */
export function backToLoginOn401(error) {
  if (error instanceof ApiError && error.status === 401) {
    clearSession();
    location.replace(loginUrl());
    return true;
  }
  return false;
}
