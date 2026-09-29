// @ts-check
/**
 * The bid log (LI-PROMPT-BPOMAX-RADAR-20260927, 4.4): one entry per bid the owner says
 * they placed on Freelancer.com, with what the project, price and score were at that
 * moment, so replies and awards can later be read against them.
 */
import { band } from './score.js';

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
 * @property {'auto' | 'manual'} [placedBy] `auto` when Auto-bid placed it; absent or `manual`
 *   when the owner did (LI-PROMPT-BPOMAX-AUTOBID-20260928, constraint 5)
 * @property {string | null} [freelancerBidId] the bid's id on Freelancer.com, when placed there by this page
 * @property {number | null} [apiStatus] the HTTP status Freelancer.com answered the bid with
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
 * Why Place now must not send another bid: the bids logged in the SAST month `now` falls
 * in have reached the monthly limit set in Settings. Null when there is room, or when no
 * limit is set (a blank limit means no check).
 * @param {LogEntry[]} log
 * @param {number | null} limit
 * @param {number} now
 * @returns {string | null}
 */
export function monthlyLimitProblem(log, limit, now) {
  if (limit === null) return null;
  const count = bidsThisMonth(log, now);
  if (count < limit) return null;
  return `The monthly limit in Settings is reached (${String(count)} of ${String(limit)} bids logged this month), so Place now is off.`;
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

/**
 * A bid after the owner presses one of its status buttons. Replied and Awarded mean the
 * client answered; No reply and Back to sent mean they have not; Lost leaves that as it
 * was, since a bid can be lost with or without an answer. An award's figures start at the
 * bid's own price and no delivery cost, for the owner to correct, and are kept if the
 * status moves away and back.
 * @param {LogEntry} entry
 * @param {BidStatus} status
 * @returns {LogEntry}
 */
export function withStatus(entry, status) {
  const replied =
    status === 'replied' || status === 'awarded' ? true : status === 'lost' ? entry.replied : false;
  const award =
    status === 'awarded' && !entry.award
      ? { agreedPrice: entry.price, deliveryCostUsd: 0, developer: null, note: '' }
      : entry.award;
  return { ...entry, status, replied, award };
}

/**
 * @typedef {{ numerator: number, denominator: number, ratio: number | null }} Rate
 * @typedef {{ key: string, name: string, bids: number, replies: number, awards: number, replyRate: Rate, winRate: Rate }} Split
 * @typedef {object} Totals
 * @property {number} bids
 * @property {number} replies
 * @property {Rate} replyRate replies ÷ bids
 * @property {number} awards
 * @property {Rate} winRate awards ÷ replies
 * @property {number} awardedUsd agreed prices at each bid's own USD rate
 * @property {number} deliveryUsd
 * @property {number | null} feeUsd null while the fee % is not set
 * @property {number} marginUsd awarded − delivery − fee (the fee only when set)
 * @property {{ awarded: number, delivery: number, margin: number } | null} zar null while no USD→ZAR rate is set
 * @property {Split[]} byTemplate
 * @property {Split[]} byBand always the three bands, lowest first
 */

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {Rate}
 */
const rate = (numerator, denominator) => ({
  numerator,
  denominator,
  ratio: denominator ? numerator / denominator : null,
});

/** @param {LogEntry} entry */
const isAward = (entry) => entry.status === 'awarded';

/**
 * @param {LogEntry[]} entries
 * @param {string} key
 * @param {string} name
 * @returns {Split}
 */
function split(entries, key, name) {
  const replies = entries.filter((e) => e.replied).length;
  const awards = entries.filter(isAward).length;
  return {
    key,
    name,
    bids: entries.length,
    replies,
    awards,
    replyRate: rate(replies, entries.length),
    winRate: rate(awards, replies),
  };
}

/**
 * @param {LogEntry[]} entries
 * @param {{ feePct: number | null, usdToZar: number | null }} settings
 * @returns {Totals}
 */
function totalsOf(entries, settings) {
  const awards = entries.filter(isAward);
  const awardedUsd = awards.reduce(
    (sum, e) => sum + (e.award?.agreedPrice ?? e.price) * e.usdRate,
    0,
  );
  const deliveryUsd = awards.reduce((sum, e) => sum + (e.award?.deliveryCostUsd ?? 0), 0);
  const feeUsd = settings.feePct === null ? null : (awardedUsd * settings.feePct) / 100;
  const marginUsd = awardedUsd - deliveryUsd - (feeUsd ?? 0);
  const whole = split(entries, 'all', 'All');

  /** @type {Map<string, LogEntry[]>} */
  const templates = new Map();
  /** @type {Map<string, string>} */
  const names = new Map();
  // The log is newest first, so the first name seen for a template is its latest.
  for (const e of entries) {
    const key = e.templateId ?? 'none';
    templates.set(key, [...(templates.get(key) ?? []), e]);
    if (!names.has(key)) names.set(key, e.templateName ?? 'No template');
  }

  return {
    bids: whole.bids,
    replies: whole.replies,
    replyRate: whole.replyRate,
    awards: whole.awards,
    winRate: whole.winRate,
    awardedUsd,
    deliveryUsd,
    feeUsd,
    marginUsd,
    zar:
      settings.usdToZar === null
        ? null
        : {
            awarded: awardedUsd * settings.usdToZar,
            delivery: deliveryUsd * settings.usdToZar,
            margin: marginUsd * settings.usdToZar,
          },
    byTemplate: [...templates].map(([key, list]) => split(list, key, names.get(key) ?? key)),
    byBand: ['0–39', '40–69', '70–100'].map((name) =>
      split(
        entries.filter((e) => band(e.score) === name),
        name,
        name,
      ),
    ),
  };
}

/**
 * Every figure on the Bids tab, from the log alone: for the SAST month `now` falls in, and
 * for all time.
 * @param {LogEntry[]} log
 * @param {{ feePct: number | null, usdToZar: number | null }} settings
 * @param {number} now
 * @returns {{ month: Totals, all: Totals }}
 */
export function computeTotals(log, settings, now) {
  const month = sastMonth(now);
  return {
    month: totalsOf(
      log.filter((e) => sastMonth(e.placedAt) === month),
      settings,
    ),
    all: totalsOf(log, settings),
  };
}
