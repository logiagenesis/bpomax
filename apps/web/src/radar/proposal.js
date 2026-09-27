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

/**
 * The first sentence of the client's description (up to the first `.`, `!` or `?` that
 * ends a sentence, or the first line break), cut at 160 characters.
 * @param {string} description
 */
export function firstLine(description) {
  const text = description.trim();
  const end = /[.!?](?=\s|$)|\n/.exec(text);
  const sentence = end ? text.slice(0, end.index + (end[0] === '\n' ? 0 : 1)) : text;
  return sentence.trim().slice(0, 160).trim();
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
