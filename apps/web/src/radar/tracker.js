// @ts-check
/**
 * The bid log (LI-PROMPT-BPOMAX-RADAR-20260927, 4.4): one entry per bid the owner says
 * they placed on Freelancer.com, with what the project, price and score were at that
 * moment, so replies and awards can later be read against them.
 */

/**
 * @typedef {import('./freelancer.js').Project} Project
 * @typedef {import('./score.js').Score} Score
 * @typedef {'sent' | 'replied' | 'awarded' | 'lost' | 'no-reply'} BidStatus
 * @typedef {object} Award
 * @property {number} agreedPrice in the project's currency
 * @property {number} deliveryCostUsd 0 when delivered in-house
 * @property {string | null} developer a shortlisted developer's username, when one delivers
 * @property {string} note
 * @typedef {object} LogEntry
 * @property {string} id
 * @property {number} projectId
 * @property {string} title
 * @property {string} url
 * @property {string[]} skills
 * @property {{ min: number | null, max: number | null }} budget
 * @property {'fixed' | 'hourly'} type
 * @property {string} currency
 * @property {number} usdRate the rate when the bid was placed
 * @property {number} price in the project's currency
 * @property {number} days
 * @property {string | null} templateId
 * @property {string | null} templateName
 * @property {string} proposal
 * @property {number} score
 * @property {{ skill: number, budget: number, fresh: number, competition: number }} scoreParts
 * @property {number} bidCount bids on the project when this one was placed
 * @property {number} ageMinutes the project's age when this bid was placed
 * @property {string} placedAt ISO time
 * @property {BidStatus} status
 * @property {boolean} replied
 * @property {Award | null} award
 */

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/**
 * `2026-09` — the month an instant falls in, in SAST, so a month starts on the 1st at
 * 00:00 SAST.
 * @param {number | string} when
 */
export function sastMonth(when) {
  const d = new Date(new Date(when).getTime() + SAST_OFFSET_MS);
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {LogEntry[]} log
 * @param {number} now
 */
export function bidsThisMonth(log, now) {
  const month = sastMonth(now);
  return log.filter((entry) => sastMonth(entry.placedAt) === month).length;
}

/**
 * @param {Project} project
 * @param {Score} score
 * @param {{ price: number, days: number, template: { id: string, name: string } | null, proposal: string, id: string }} bid
 * @param {number} now
 * @returns {LogEntry}
 */
export function logEntry(project, score, bid, now) {
  const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  return {
    id: bid.id,
    projectId: project.id,
    title: project.title,
    url: project.url,
    skills: project.skills.map((skill) => skill.name),
    budget: { min: project.budgetMin, max: project.budgetMax },
    type: project.type,
    currency: project.currency,
    usdRate: project.usdRate,
    price: bid.price,
    days: bid.days,
    templateId: bid.template?.id ?? null,
    templateName: bid.template?.name ?? null,
    proposal: bid.proposal,
    score: score.total,
    scoreParts: {
      skill: round(score.parts.skill.points),
      budget: round(score.parts.budget.points),
      fresh: round(score.parts.fresh.points),
      competition: round(score.parts.competition.points),
    },
    bidCount: project.bidCount,
    ageMinutes: Math.max(0, Math.floor((now - project.submitted) / 60_000)),
    placedAt: new Date(now).toISOString(),
    status: 'sent',
    replied: false,
    award: null,
  };
}
