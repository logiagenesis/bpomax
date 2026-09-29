// @ts-check
/**
 * The proposal and opening price (LI-PROMPT-BPOMAX-RADAR-20260927, 4.3). Every sentence
 * of a proposal comes from the owner's own template; this only fills its placeholders
 * from the project. No model is called: `buildProposal` is the one place a drafting model
 * could be put later without touching the page.
 */
import { formatPrice, formatRange } from './text.js';

/**
 * @typedef {import('./freelancer.js').Project} Project
 * @typedef {{ id: string, name: string, body: string, isDefault: boolean }} Template
 * @typedef {Project & { price: number | null, days: number }} Job the project, with the
 *   price and days chosen for this bid
 */

/** The placeholders a template may use, as the templates tab lists them. */
export const PLACEHOLDERS = /** @type {const} */ ([
  ['{title}', 'the project’s title'],
  ['{skills}', 'the project’s skills that you deliver in-house, comma separated'],
  ['{budget}', 'the client’s budget, for example USD 250–750'],
  ['{price}', 'your price, for example USD 450'],
  ['{timeline_days}', 'your delivery time in days'],
  [
    '{first_line}',
    'the first sentence of the client’s description; over 160 characters it is cut at a whole word and ends with …',
  ],
]);

/** The most characters of the client's first sentence that `{first_line}` carries. */
const FIRST_LINE_MAX = 160;

/**
 * The first sentence of the client's description (up to the first `.`, `!` or `?` that
 * ends a sentence, or the first line break). Over 160 characters it is cut at the last
 * word boundary at or before the 160th and ends with `…`, so it is never more than 161
 * characters and never stops in the middle of a word. A single word longer than 160
 * characters has no boundary to cut at and is cut at 160.
 * @param {string} description
 */
export function firstLine(description) {
  const text = description.trim();
  const end = /[.!?](?=\s|$)|\n/.exec(text);
  const sentence = (end ? text.slice(0, end.index + (end[0] === '\n' ? 0 : 1)) : text).trim();
  if (sentence.length <= FIRST_LINE_MAX) return sentence;

  // The cut falls between words when the character just after it is a space.
  let cut = sentence.slice(0, FIRST_LINE_MAX);
  if (!/\s/.test(sentence.charAt(FIRST_LINE_MAX))) {
    const boundary = cut.search(/\s\S*$/);
    if (boundary > 0) cut = cut.slice(0, boundary);
  }
  // Never end on half of a surrogate pair, or on a space.
  cut = cut.replace(/[\uD800-\uDBFF]$/, '').trimEnd();
  return `${cut}…`;
}

/**
 * A `{...}` that reads as a placeholder rather than as code: a short label of letters (any
 * script), digits, spaces and `_ . - ' ’ ? !`. Code and data have punctuation this leaves
 * out (`{ color: red; }`, `{"a": 1}`), so they pass.
 */
const PLACEHOLDER = /\{([\p{L}\p{N}\s_.'’?!-]{1,80})\}/gu;

/**
 * The placeholders still in a text, as written and once each, in the order they first
 * appear: `{skills}`, but also a mistyped `{Title}`, `{first line}` (a space for the `_`),
 * `{ price }` or `{project.title}`, which `buildProposal` leaves as it found them. A label
 * needs a letter in it and must sit on one line. A bid that still has one must not reach a
 * client.
 * @param {string} text
 * @returns {string[]}
 */
export function unfilledPlaceholders(text) {
  const found = new Set();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const label = String(match[1]);
    if (/\p{L}/u.test(label) && !/[\r\n]/.test(label)) found.add(match[0]);
  }
  return [...found];
}

/**
 * The line to show when a bid still has placeholders in it, or null when it has none.
 * @param {string[]} left from `unfilledPlaceholders`
 * @returns {string | null}
 */
export function unfilledMessage(left) {
  if (!left.length) return null;
  const list =
    left.length === 1
      ? String(left[0])
      : `${left.slice(0, -1).join(', ')} and ${String(left.at(-1))}`;
  return `Fill or remove ${list} before bidding.`;
}

/**
 * The opening price: the project's maximum times the owner's percentage, kept within the
 * project's own minimum and maximum, as a whole number in the project's currency. Null
 * when the project gives no budget.
 * @param {Project} project
 * @param {number} pct
 * @returns {number | null}
 */
export function openingPrice(project, pct) {
  const max = project.budgetMax ?? project.budgetMin;
  const min = project.budgetMin ?? project.budgetMax;
  if (max === null || min === null) return null;
  const clamped = Math.min(max, Math.max(min, (max * pct) / 100));
  const rounded = Math.round(clamped);
  if (rounded > max) return Math.floor(max);
  if (rounded < min) return Math.ceil(min);
  return rounded;
}

/**
 * The proposal text: the template with its placeholders filled. A placeholder with
 * nothing to fill it (no budget, no price, no in-house skill among the project's), or one
 * this does not know, is left as written, so the owner sees it before sending.
 * @param {Job} job
 * @param {Template} template
 * @param {{ inHouse: { id: number }[] }} settings
 * @returns {string}
 */
export function buildProposal(job, template, settings) {
  const inHouse = new Set(settings.inHouse.map((skill) => skill.id));
  const matched = job.skills.filter((skill) => inHouse.has(skill.id)).map((skill) => skill.name);
  /** @type {Record<string, string | null>} */
  const values = {
    title: job.title,
    skills: matched.length ? matched.join(', ') : null,
    budget: formatRange(job.budgetMin, job.budgetMax, job.currency),
    price: job.price === null ? null : formatPrice(job.price, job.currency),
    timeline_days: String(job.days),
    first_line: firstLine(job.description) || null,
  };
  return template.body.replace(/\{([a-z_]+)\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? (values[name] ?? whole) : whole,
  );
}
