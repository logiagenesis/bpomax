// @ts-check
/**
 * Everything the radar page keeps lives in this browser's localStorage, under `radar.*`
 * (LI-PROMPT-BPOMAX-RADAR-20260927, constraint 3: no server, no account). Every read and
 * write is wrapped: a private window, blocked site data or a full quota must leave the
 * page working, just without memory, and the page says so.
 */

const PREFIX = 'radar.';

/**
 * @typedef {{ id: number, name: string }} Skill
 * @typedef {'both' | 'fixed' | 'hourly'} TypeFilter
 * @typedef {object} Filters
 * @property {TypeFilter} type
 * @property {number | null} minBudgetUsd fixed projects: the most the client will pay, in USD
 * @property {number | null} minHourlyUsd hourly projects: the top of the rate, in USD
 * @property {number | null} maxBids
 * @property {number | null} maxAgeHours
 * @property {string} excludeWords comma-separated, matched in the title, any case
 * @property {boolean} hideActed hide projects already bid on or dismissed
 * @typedef {{ skill: number, budget: number, fresh: number, competition: number }} Weights
 * @typedef {object} Settings
 * @property {Skill[]} skills the skills whose projects the feed reads; none = every project
 * @property {Skill[]} inHouse the skills Logi-Ink delivers in-house (scoring's skill fit)
 * @property {0 | 2 | 5 | 10} refreshMinutes 0 = manual only
 * @property {Filters} filters
 * @property {Weights} weights
 * @property {number} pricePct the opening price as a share of the project's maximum
 * @property {number} defaultDays
 * @property {number | null} monthlyLimit bids the membership allows a month; null = not shown
 * @property {number | null} usdToZar typed by the owner; null = no ZAR shown
 * @property {number | null} feePct Freelancer's fee on an award; null = not set
 * @property {number} alertThreshold
 * @property {boolean} alertsOn
 * @property {number} devMinCompletion percent
 * @property {number} devMinReviews
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  skills: [],
  inHouse: [],
  refreshMinutes: 2,
  filters: {
    type: /** @type {TypeFilter} */ ('both'),
    minBudgetUsd: null,
    minHourlyUsd: null,
    maxBids: null,
    maxAgeHours: null,
    excludeWords: '',
    hideActed: true,
  },
  weights: { skill: 35, budget: 25, fresh: 20, competition: 20 },
  pricePct: 60,
  defaultDays: 7,
  monthlyLimit: null,
  usdToZar: null,
  feePct: null,
  alertThreshold: 70,
  alertsOn: false,
  devMinCompletion: 90,
  devMinReviews: 20,
});

/**
 * @param {string} key without the `radar.` prefix
 * @param {T} fallback
 * @returns {T}
 * @template T
 */
export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : /** @type {T} */ (JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key without the `radar.` prefix
 * @param {unknown} value
 * @returns {boolean} false when the browser would not keep it
 */
export function writeJson(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Stored settings over the defaults, one level deep, so a setting added later has its
 * default in a browser that saved settings before it existed.
 * @param {unknown} stored
 * @returns {Settings}
 */
export function mergeSettings(stored) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!isObject(stored)) return base;
  const s = /** @type {Record<string, unknown>} */ (stored);
  const merged = /** @type {Record<string, unknown>} */ ({ ...base });
  for (const [key, value] of Object.entries(base)) {
    if (!(key in s)) continue;
    const saved = s[key];
    merged[key] =
      isObject(value) && isObject(saved)
        ? { .../** @type {object} */ (value), .../** @type {object} */ (saved) }
        : saved;
  }
  return /** @type {Settings} */ (merged);
}

export function loadSettings() {
  return mergeSettings(readJson('settings', null));
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  return writeJson('settings', settings);
}
