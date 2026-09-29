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
  ['{first_line}', 'the first sentence of the client’s description, at most 160 characters'],
]);

/** The most characters `{first_line}` carries, the ellipsis included. */
const FIRST_LINE_MAX = 160;

/**
 * The first sentence of the client's description (up to the first `.`, `!` or `?` that
 * ends a sentence, or the first line break). Longer than 160 characters, it is cut at the
 * last space so that it and the `…` after it come to at most 160 characters. With no space
 * in the first 159 characters it is cut at 159. A shorter one is returned as it is.
 * @param {string} description
 */
export function firstLine(description) {
  const text = description.trim();
  const end = /[.!?](?=\s|$)|\n/.exec(text);
  const sentence = (end ? text.slice(0, end.index + (end[0] === '\n' ? 0 : 1)) : text).trim();
  if (sentence.length <= FIRST_LINE_MAX) return sentence;

  // The last space at or before the 160th character leaves at most 159 to keep.
  const space = sentence.slice(0, FIRST_LINE_MAX).search(/\s\S*$/);
  const kept = space > 0 ? sentence.slice(0, space) : sentence.slice(0, FIRST_LINE_MAX - 1);
  // Never end on half of a surrogate pair, or on a space.
  return `${kept.replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
}

/**
 * Every distinct `{…}` in a text, as written, in the order it first appears: `{skills}`,
 * `{Client_Name}`, `{ name }`, `{made-up}`. `buildProposal` fills only the lower-case names
 * it knows and leaves any other as it found it, so a bid that still has one must not reach
 * a client. Any text in curly braces counts: the owner can take the braces out.
 * @param {string} text
 * @returns {string[]}
 */
export function findPlaceholders(text) {
  return [...new Set(text.match(/\{[^{}\n]{1,40}\}/g) ?? [])];
}

/**
 * The line for `#p-error` when a bid still has braces in it, or null when it has none.
 * @param {string[]} found from `findPlaceholders`
 * @returns {string | null}
 */
export function placeholderProblem(found) {
  return found.length
    ? `Fill or remove ${found.join(', ')} before bidding. Any text in curly braces is blocked.`
    : null;
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
