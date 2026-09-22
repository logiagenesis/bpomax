// @ts-check
import { apiGet } from './lib/api.js';
import { formatDate, formatMoney, formatPercent } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * The dashboard (ARB-061, docs/01 section I). Every figure is `GET /v1/dashboard`'s,
 * whose formulas are written beside its fields (apps/api/src/routes/dashboard.ts);
 * this page formats and never calculates.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`dashboard is missing #${id}`);
  return element;
}

const status = byId('status');
const refresh = /** @type {HTMLButtonElement} */ (byId('refresh'));

/** @param {{ currency: string, amountMinor: string, count: number }[]} lines */
function moneyLines(lines) {
  if (lines.length === 0) return 'R0,00';
  return lines.map((line) => formatMoney(BigInt(line.amountMinor), line.currency)).join(' + ');
}

/**
 * @param {{
 *   period: { start: string, end: string },
 *   revenueInZarMinor: string, revenueOutZarMinor: string, realisedMarginZarMinor: string,
 *   unconverted: { direction: 'in' | 'out', currency: string, amountMinor: string, count: number }[],
 *   pipeline: { currency: string, amountMinor: string, count: number }[],
 *   replies: number,
 *   bids: { queued: number, submitted: number, won: number, lost: number },
 *   winRate: number | null,
 *   retainers: { currency: string, amountMinor: string, count: number }[],
 * }} d
 */
function render(d) {
  byId('period').textContent =
    `Month to date: ${formatDate(d.period.start)} to ${formatDate(d.period.end)}, South African time.`;
  byId('revenue-in').textContent = formatMoney(BigInt(d.revenueInZarMinor), 'ZAR');
  byId('revenue-out').textContent = formatMoney(BigInt(d.revenueOutZarMinor), 'ZAR');
  byId('margin').textContent = formatMoney(BigInt(d.realisedMarginZarMinor), 'ZAR');
  byId('pipeline').textContent = moneyLines(d.pipeline);
  const open = d.pipeline.reduce((sum, line) => sum + line.count, 0);
  byId('pipeline-note').textContent =
    `${String(open)} open deal${open === 1 ? '' : 's'}, applied through delivered.`;
  byId('replies').textContent = String(d.replies);
  byId('win-rate').textContent = d.winRate === null ? 'No decisions yet' : formatPercent(d.winRate);
  byId('win-rate-note').textContent =
    `${String(d.bids.won)} won, ${String(d.bids.lost)} lost this month.`;
  byId('retainers').textContent = moneyLines(d.retainers);
  const retainerCount = d.retainers.reduce((sum, line) => sum + line.count, 0);
  byId('retainers-note').textContent =
    `${String(retainerCount)} active retainer${retainerCount === 1 ? '' : 's'}, monthly total.`;
  byId('bids').textContent = `${String(d.bids.queued)} waiting`;
  byId('bids-link').textContent = `${String(d.bids.submitted)} sent this month. Open approvals`;

  const section = byId('unconverted');
  const list = byId('unconverted-list');
  list.replaceChildren();
  for (const line of d.unconverted) {
    const item = document.createElement('li');
    item.textContent = `${line.direction === 'in' ? 'Received' : 'Paid'} ${formatMoney(BigInt(line.amountMinor), line.currency)} across ${String(line.count)} payment${line.count === 1 ? '' : 's'}.`;
    list.append(item);
  }
  section.hidden = d.unconverted.length === 0;
}

async function load() {
  await runAction(
    refresh,
    status,
    async () => {
      try {
        const dashboard = await apiGet('/v1/dashboard');
        render(/** @type {any} */ (dashboard));
      } catch (error) {
        if (backToLoginOn401(error)) return;
        throw error;
      }
    },
    { success: 'Figures are up to date.' },
  );
}

refresh.addEventListener('click', () => void load());

void mountShell().then((me) => {
  if (me) void load();
});
