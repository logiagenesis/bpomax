// @ts-check
/**
 * How the radar page writes amounts and ages (LI-PROMPT-BPOMAX-RADAR-20260927). Freelancer
 * gives budgets as plain numbers in the project's currency, so they are shown as whole
 * units with the ISO code first and a no-break space between thousands, as the rest of the
 * app writes money (lib/format.js, D-024): `INR 12 500`, `USD 250–750`.
 */

/** A no-break space, so an amount never wraps across two lines. */
const GROUP = ' ';

/**
 * `12 500` — a whole number with grouped thousands.
 * @param {number} value
 */
function formatWhole(value) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

/**
 * `USD 450`
 * @param {number} value
 * @param {string} currency
 */
export function formatAmount(value, currency) {
  return `${currency} ${formatWhole(value)}`;
}

/**
 * `USD 250–750`, or `USD 250` when both ends are the same or only one is known, or null
 * when neither is.
 * @param {number | null} min
 * @param {number | null} max
 * @param {string} currency
 */
export function formatRange(min, max, currency) {
  if (min === null && max === null) return null;
  if (min === null || max === null || Math.round(min) === Math.round(max)) {
    return formatAmount(/** @type {number} */ (min ?? max), currency);
  }
  return `${currency} ${formatWhole(min)}–${formatWhole(max)}`;
}

/**
 * `just now`, `14 min ago`, `3 h ago`, `2 d ago`.
 * @param {number} then epoch milliseconds
 * @param {number} now epoch milliseconds
 */
export function formatAge(then, now) {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / 24))} d ago`;
}

/**
 * A project's budget as a row shows it: `INR 1 500–12 500 (USD 16–130) · Fixed`, the USD
 * figure only when the project is in another currency, and `per hour` when hourly.
 * @param {import('./freelancer.js').Project} project
 */
export function budgetText(project) {
  const { budgetMin: min, budgetMax: max, currency, usdRate: rate } = project;
  const own = formatRange(min, max, currency) ?? 'No budget given';
  const usd =
    currency === 'USD' || (min === null && max === null)
      ? ''
      : ` (${String(formatRange(min === null ? null : min * rate, max === null ? null : max * rate, 'USD'))})`;
  return project.type === 'hourly' ? `${own}${usd} per hour · Hourly` : `${own}${usd} · Fixed`;
}

/**
 * A price as typed: `USD 450`, or `USD 12,50` when it has cents.
 * @param {number} value
 * @param {string} currency
 */
export function formatPrice(value, currency) {
  const cents = Math.round(value * 100);
  if (cents % 100 === 0) return formatAmount(cents / 100, currency);
  const whole = formatWhole(Math.trunc(cents / 100));
  return `${currency} ${whole},${String(Math.abs(cents % 100)).padStart(2, '0')}`;
}
