// @ts-check
import { REFERRAL_PARAM, validateAffiliate } from '@arbitron/core';
import { ApiError, apiGet, apiSend } from './lib/api.js';
import { formatDateTime } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * Affiliates (ARB-430). `GET /v1/affiliates`: each referral code with its clicks, the
 * organisations created after one, and those that went on to a paid plan, counted by the
 * API from stored rows. Only the house organisation's owner runs the programme; anyone
 * else is told so. The commission is shown as the owner recorded it (D-071).
 */

/**
 * @typedef {{ id: string, code: string, ownerEmail: string | null, commissionPct: string | null,
 *   active: boolean, clicks: number, signUps: number, paid: number, lastClickAt: string | null }} Affiliate
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`affiliates is missing #${id}`);
  return element;
}

const status = byId('status');
const form = /** @type {HTMLFormElement} */ (byId('new-affiliate'));
const create = /** @type {HTMLButtonElement} */ (byId('create'));
const code = /** @type {HTMLInputElement} */ (byId('code'));
const ownerEmail = /** @type {HTMLInputElement} */ (byId('ownerEmail'));
const commission = /** @type {HTMLInputElement} */ (byId('commissionPct'));
const listSection = byId('list-section');
const listEmpty = byId('list-empty');
const listTable = byId('list-table');
const rows = byId('rows');

/**
 * The link an affiliate shares: this site's address with the code.
 * @param {string} affiliateCode
 */
function linkFor(affiliateCode) {
  const url = new URL('./index.html', location.href);
  url.searchParams.set(REFERRAL_PARAM, affiliateCode);
  return url.href;
}

/** @param {string} text */
function commissionText(text) {
  return `${String(Number(text)).replace('.', ',')}%`;
}

/** @param {Affiliate} affiliate */
function row(affiliate) {
  const tr = document.createElement('tr');
  tr.dataset.code = affiliate.code;
  /** @param {string | Node} content @param {string} [className] */
  const cell = (content, className) => {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.append(content);
    return td;
  };
  const codeCell = document.createElement('div');
  codeCell.className = 'stack';
  const strong = document.createElement('strong');
  strong.textContent = affiliate.code;
  const link = document.createElement('code');
  link.textContent = linkFor(affiliate.code);
  codeCell.append(strong, link);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn--secondary';
  toggle.textContent = affiliate.active ? 'Switch off' : 'Switch on';
  toggle.setAttribute(
    'aria-label',
    `${affiliate.active ? 'Switch off' : 'Switch on'} the link for ${affiliate.code}`,
  );
  toggle.addEventListener('click', () => {
    void runAction(
      toggle,
      status,
      async () => {
        await apiSend('PATCH', `/v1/affiliates/${affiliate.id}`, { active: !affiliate.active });
        await load();
        return affiliate.active
          ? `The link for ${affiliate.code} is off: new clicks on it no longer count.`
          : `The link for ${affiliate.code} is on again.`;
      },
      { success: (message) => message },
    );
  });

  tr.append(
    cell(codeCell),
    cell(affiliate.ownerEmail ?? '—'),
    cell(
      affiliate.commissionPct === null ? 'Not recorded' : commissionText(affiliate.commissionPct),
      'num',
    ),
    cell(String(affiliate.clicks), 'num'),
    cell(String(affiliate.signUps), 'num'),
    cell(String(affiliate.paid), 'num'),
    cell(affiliate.lastClickAt ? formatDateTime(affiliate.lastClickAt) : '—'),
    cell(toggle),
  );
  return tr;
}

async function load() {
  try {
    const body = /** @type {{ affiliates: Affiliate[] }} */ (await apiGet('/v1/affiliates'));
    form.hidden = false;
    listSection.hidden = false;
    rows.replaceChildren(...body.affiliates.map(row));
    listTable.hidden = body.affiliates.length === 0;
    listEmpty.hidden = body.affiliates.length > 0;
    return body.affiliates.length;
  } catch (error) {
    if (backToLoginOn401(error)) return 0;
    if (error instanceof ApiError && error.status === 403) {
      form.hidden = true;
      listSection.hidden = true;
    }
    throw error;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = {
    code: code.value,
    ownerEmail: ownerEmail.value,
    commissionPct: commission.value,
  };
  const parsed = validateAffiliate(input);
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
        await apiSend('POST', '/v1/affiliates', input);
      } catch (error) {
        if (error instanceof ApiError && error.errors.length > 0)
          showFieldErrors(form, error.errors);
        throw error;
      }
      form.reset();
      await load();
      return `Added ${parsed.value.code}. Its link is in the list below.`;
    },
    { success: (message) => message },
  );
});

void mountShell().then((me) => {
  if (!me) return;
  void runAction(
    /** @type {HTMLButtonElement} */ (document.createElement('button')),
    status,
    load,
    { success: (count) => `Showing ${String(count)} ${count === 1 ? 'affiliate' : 'affiliates'}.` },
  );
});
