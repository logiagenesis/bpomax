// @ts-check
/**
 * The setup line under the page title and the export reminder (LI-PROMPT-BPOMAX-FIX-20260929,
 * U-01 and U-02). Both only report: nothing here blocks browsing, bidding or Export.
 */
import { formatDate } from '../lib/format.js';
import { tokenState } from './account.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A last Export older than this many days earns a warning. */
const EXPORT_WARN_AFTER_DAYS = 7;

/**
 * @typedef {'set' | 'unset' | 'warn'} SetupState `warn`: set, but needs the owner's attention
 * @typedef {object} SetupItem
 * @property {string} key
 * @property {string} label
 * @property {SetupState} state
 * @property {string} text how the item is put in words: `set`, `not set`, `saved`, …
 */

/**
 * Where the last Export stands at `now`. Never exported warns only when the browser holds
 * something worth a copy (`hasData`), so a first visit is not nagged; an Export more than 7
 * days old warns. `now` before the last Export (a clock set back) counts as fresh.
 * @param {number | null} lastExport epoch milliseconds of the last Export, or null
 * @param {number} now epoch milliseconds
 * @param {boolean} hasData whether the browser holds templates or logged bids
 * @returns {{ text: string, stale: boolean, warning: string | null }}
 */
export function exportNote(lastExport, now, hasData) {
  const keep = 'What you save here stays only in this browser: press Export to keep a copy.';
  if (lastExport === null) {
    return {
      text: 'Never exported',
      stale: hasData,
      warning: hasData ? `You have not exported yet. ${keep}` : null,
    };
  }
  const stale = now - lastExport > EXPORT_WARN_AFTER_DAYS * DAY_MS;
  const days = Math.floor((now - lastExport) / DAY_MS);
  return {
    text: `Last export: ${formatDate(lastExport)}`,
    stale,
    warning: stale
      ? `Your last export was ${String(days)} days ago (${formatDate(lastExport)}). ${keep}`
      : null,
  };
}

/**
 * @param {string} key
 * @param {string} label
 * @param {boolean} on
 * @returns {SetupItem}
 */
function flag(key, label, on) {
  return { key, label, state: on ? 'set' : 'unset', text: on ? 'set' : 'not set' };
}

/**
 * @param {import('./account.js').StoredToken | null} stored
 * @param {number} now
 * @returns {SetupItem}
 */
function tokenItem(stored, now) {
  /** @param {SetupState} state @param {string} text */
  const item = (state, text) => ({ key: 'token', label: 'Token', state, text });
  const { kind } = tokenState(stored, now);
  if (kind === 'none') return item('unset', 'not saved');
  if (kind === 'expired') return item('warn', 'expired');
  if (stored?.problem) return item('warn', 'refused');
  if (!stored?.account) return item('warn', 'not checked');
  return kind === 'soon' ? item('warn', 'expiring') : item('set', 'saved');
}

/**
 * The setup line: what the owner has set up, and what not, in this order.
 * @param {object} input
 * @param {import('./store.js').Settings} input.settings
 * @param {unknown[]} input.templates
 * @param {import('./account.js').StoredToken | null} input.stored
 * @param {number | null} input.lastExport
 * @param {boolean} input.hasData
 * @param {number} now epoch milliseconds
 * @returns {SetupItem[]}
 */
export function setupItems({ settings, templates, stored, lastExport, hasData }, now) {
  const note = exportNote(lastExport, now, hasData);
  return [
    flag('skills', 'Skills', settings.skills.length > 0),
    flag('inhouse', 'In-house ticks', settings.inHouse.length > 0),
    flag('template', 'Template', templates.length > 0),
    flag('limit', 'Monthly limit', settings.monthlyLimit !== null),
    flag('fee', 'Fee %', settings.feePct !== null),
    flag('rate', 'USD→ZAR', settings.usdToZar !== null),
    tokenItem(stored, now),
    {
      key: 'export',
      label: 'Last export',
      state: lastExport === null ? 'unset' : note.stale ? 'warn' : 'set',
      text: lastExport === null ? 'never' : formatDate(lastExport),
    },
  ];
}
