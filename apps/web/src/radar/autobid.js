// @ts-check
/**
 * Auto-bid's rules (LI-PROMPT-BPOMAX-AUTOBID-20260928, constraints 3 and 4): what must be
 * set before it can be switched on, and, for each project in the ranked feed, whether it
 * is bid on by itself or skipped, and why. Nothing here calls Freelancer.com; the page
 * places what this says to place.
 */
import { checkAutoSendGuardrails } from '@arbitron/core';
import { buildProposal, openingPrice } from './proposal.js';
import { bidsThisMonth } from './tracker.js';

/**
 * @typedef {import('./freelancer.js').Project} Project
 * @typedef {import('./score.js').Score} Score
 * @typedef {import('./proposal.js').Template} Template
 * @typedef {import('./tracker.js').LogEntry} LogEntry
 * @typedef {import('./store.js').Settings} Settings
 * @typedef {object} AutoBid
 * @property {boolean} on
 * @property {number} dailyCap automatic bids a day, SAST
 * @property {number} minScore the lowest rank score bid on
 * @property {number} maxAgeMinutes the oldest project bid on
 * @typedef {object} Placement
 * @property {true} place
 * @property {number} price in the project's currency
 * @property {number} days
 * @property {Template} template
 * @property {string} proposal
 * @typedef {{ place: false, reason: string }} Skip
 */

/** Off, with the brief's defaults: 10 a day, score 70 or more, under 15 minutes old. */
export const DEFAULT_AUTOBID = Object.freeze({
  on: false,
  dailyCap: 10,
  minScore: 70,
  maxAgeMinutes: 15,
});

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/**
 * `2026-09-28`, the day an instant falls on in SAST.
 * @param {number | string} when
 */
export function sastDay(when) {
  return new Date(new Date(when).getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Automatic bids placed on `now`'s SAST day.
 * @param {LogEntry[]} log
 * @param {number} now
 */
export function autoBidsToday(log, now) {
  const today = sastDay(now);
  return log.filter((e) => e.placedBy === 'auto' && sastDay(e.placedAt) === today).length;
}

/**
 * @param {Template[]} templates
 * @returns {Template | null}
 */
function defaultTemplate(templates) {
  return templates.find((t) => t.isDefault) ?? null;
}

/**
 * What stops Auto-bid being switched on (constraint 4): each missing guardrail, in words.
 * The cap and score floor are checked by the same rule the scanners use.
 * @param {{ auto: AutoBid, settings: Settings, templates: Template[], tokenOk: boolean }} state
 * @returns {string[]} empty when it may be switched on
 */
export function switchOnProblems({ auto, settings, templates, tokenOk }) {
  const problems = [];
  if (!tokenOk) problems.push('Paste a Freelancer token that Freelancer.com accepts.');
  for (const error of checkAutoSendGuardrails({
    autoSend: true,
    dailyCap: auto.dailyCap,
    minScore: auto.minScore,
  })) {
    problems.push(
      error.field === 'dailyCap'
        ? 'Set the most automatic bids a day, 1 or more.'
        : 'Set the lowest rank score to bid on.',
    );
  }
  if (!(auto.maxAgeMinutes >= 1)) problems.push('Set the oldest project to bid on, in minutes.');
  if (settings.monthlyLimit === null) {
    problems.push('Set the bids your membership allows a month, under Bidding.');
  }
  if (!settings.inHouse.length) problems.push('Pick at least one skill delivered in-house.');
  if (!defaultTemplate(templates)) problems.push('Mark one template as the default.');
  return problems;
}

/**
 * Whether one project from the ranked feed is bid on by itself now, with what, or why not.
 * Checked in this order: already bid on or dismissed, the daily cap, the monthly
 * allowance, the project's age, its score, its skills, its budget, then the template.
 * @param {Project} project
 * @param {Score} score
 * @param {object} context
 * @param {AutoBid} context.auto
 * @param {Settings} context.settings
 * @param {Template[]} context.templates
 * @param {LogEntry[]} context.log
 * @param {Set<number>} context.dismissed
 * @param {number} context.now
 * @returns {Placement | Skip}
 */
export function decide(project, score, { auto, settings, templates, log, dismissed, now }) {
  /** @param {string} reason @returns {Skip} */
  const skip = (reason) => ({ place: false, reason });
  if (log.some((e) => e.projectId === project.id)) return skip('Already bid on.');
  if (dismissed.has(project.id)) return skip('You dismissed it.');
  const today = autoBidsToday(log, now);
  if (today >= auto.dailyCap) {
    return skip(
      `The daily cap is reached: ${String(today)} automatic ${today === 1 ? 'bid' : 'bids'} today.`,
    );
  }
  if (settings.monthlyLimit !== null && bidsThisMonth(log, now) >= settings.monthlyLimit) {
    return skip(`This month’s ${String(settings.monthlyLimit)} bids are used.`);
  }
  const age = Math.floor((now - project.submitted) / 60_000);
  if (age > auto.maxAgeMinutes) {
    return skip(`Posted ${String(age)} minutes ago; the limit is ${String(auto.maxAgeMinutes)}.`);
  }
  if (score.total < auto.minScore) {
    return skip(`Scores ${String(score.total)}; the lowest bid on is ${String(auto.minScore)}.`);
  }
  const inHouse = new Set(settings.inHouse.map((s) => s.id));
  if (!project.skills.some((s) => inHouse.has(s.id))) {
    return skip('None of its skills is delivered in-house.');
  }
  const price = openingPrice(project, settings.pricePct);
  if (price === null || price <= 0) return skip('It gives no budget to price from.');
  const template = defaultTemplate(templates);
  if (!template) return skip('No default template.');
  const days = settings.defaultDays;
  const proposal = buildProposal({ ...project, price, days }, template, settings);
  return { place: true, price, days, template, proposal };
}
