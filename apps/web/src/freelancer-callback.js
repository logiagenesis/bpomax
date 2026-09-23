// @ts-check
import { apiSend } from './lib/api.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';

/**
 * Where Freelancer.com sends the browser back after the person approves access (ARB-020;
 * FREELANCER_REDIRECT_URI points here). The address carries `?code=`
 * (https://developers.freelancer.com/docs/authentication/generating-access-tokens,
 * "Receive Authorization Response"). The page hands the code to the API, which trades it
 * for tokens the browser never sees, and says what happened.
 */
const status = /** @type {HTMLElement} */ (document.getElementById('status'));

/**
 * @param {'success' | 'error' | 'info'} kind
 * @param {string} text
 */
function say(kind, text) {
  status.className = `alert alert--${kind}`;
  status.textContent = text;
}

async function finish() {
  const code = new URLSearchParams(location.search).get('code');
  // The code is single-use and should not linger in the address bar or the history.
  history.replaceState(null, '', location.pathname);
  if (!code) {
    say(
      'error',
      'Freelancer.com did not send back an authorisation code, so nothing was connected. Go back to Settings and try again.',
    );
    return;
  }
  say('info', 'Finishing the connection…');
  try {
    const body =
      /** @type {{ account: { externalUserId: string, externalUsername: string | null } }} */ (
        await apiSend('POST', '/v1/platform-accounts/freelancer/callback', { code })
      );
    const name = body.account.externalUsername ?? body.account.externalUserId;
    say('success', `Connected the Freelancer.com account ${name}.`);
  } catch (e) {
    if (backToLoginOn401(e)) return;
    say('error', e instanceof Error ? e.message : String(e));
  }
}

void mountShell().then((me) => {
  if (me) void finish();
});
