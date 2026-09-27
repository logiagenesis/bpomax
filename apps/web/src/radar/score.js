// @ts-check
/**
 * The rank score (LI-PROMPT-BPOMAX-RADAR-20260927, 4.2): 0 to 100, from the search's own
 * fields only. Four parts, each a share of its weight:
 *
 * | Part        | Full points                                   | No points            |
 * |-------------|-----------------------------------------------|----------------------|
 * | Skill fit   | every skill of the project is delivered in-house | none is           |
 * | Budget      | top of budget ≥ USD 3 000 (hourly: ≥ USD 50/h) | ≤ USD 100 (≤ USD 10/h) |
 * | Freshness   | posted ≤ 15 minutes ago                        | 6 hours ago or more  |
 * | Competition | no bids yet                                    | 50 bids or more      |
 *
 * linear between the two ends. The weights are the owner's (default 35, 25, 20, 20); when
 * they do not add up to 100 the parts are scaled so the most a project can score is 100.
 */
import { topUsd } from './freelancer.js';

/**
 * @typedef {import('./freelancer.js').Project} Project
 * @typedef {import('./store.js').Weights} Weights
 * @typedef {'skill' | 'budget' | 'fresh' | 'competition'} PartName
 * @typedef {{ points: number, max: number, why: string }} Part
 * @typedef {{ total: number, parts: Record<PartName, Part> }} Score
 */

const MIN = 60_000;

/**
 * Where `value` falls between `zeroAt` (0) and `fullAt` (1), clamped; works either way round.
 * @param {number} value
 * @param {number} zeroAt
 * @param {number} fullAt
 */
function share(value, zeroAt, fullAt) {
  const t = (value - zeroAt) / (fullAt - zeroAt);
  return Math.min(1, Math.max(0, t));
}

/** @param {number} n */
const usd = (n) => `USD ${String(Math.round(n))}`;

/**
 * @param {Project} project
 * @param {{ inHouse: { id: number }[], weights: Weights }} settings
 * @param {number} now epoch milliseconds
 * @returns {Score}
 */
export function scoreProject(project, settings, now) {
  const w = settings.weights;
  const sum = w.skill + w.budget + w.fresh + w.competition;
  const scale = sum > 0 ? 100 / sum : 0;

  const inHouse = new Set(settings.inHouse.map((skill) => skill.id));
  const matched = project.skills.filter((skill) => inHouse.has(skill.id)).length;
  const skillShare = project.skills.length ? matched / project.skills.length : 0;

  const top = topUsd(project);
  const hourly = project.type === 'hourly';
  const budgetShare = top === null ? 0 : hourly ? share(top, 10, 50) : share(top, 100, 3000);

  const age = (now - project.submitted) / MIN;
  const freshShare = share(age, 360, 15);

  const competitionShare = share(project.bidCount, 50, 0);

  /**
   * @param {number} weight
   * @param {number} fraction
   * @param {string} why
   * @returns {Part}
   */
  const part = (weight, fraction, why) => ({
    points: weight * scale * fraction,
    max: weight * scale,
    why,
  });

  const parts = {
    skill: part(
      w.skill,
      skillShare,
      `${String(matched)} of ${String(project.skills.length)} skills delivered in-house`,
    ),
    budget: part(
      w.budget,
      budgetShare,
      top === null
        ? 'no budget given'
        : hourly
          ? `up to ${usd(top)} an hour (full at USD 50)`
          : `up to ${usd(top)} (full at USD 3000)`,
    ),
    fresh: part(w.fresh, freshShare, `posted ${String(Math.max(0, Math.floor(age)))} min ago`),
    competition: part(
      w.competition,
      competitionShare,
      `${String(project.bidCount)} bids so far (none at 50)`,
    ),
  };
  const total = Math.round(
    parts.skill.points + parts.budget.points + parts.fresh.points + parts.competition.points,
  );
  return { total, parts };
}

/**
 * Highest score first; on a tie, the newest first.
 * @template {{ project: Project, score: Score }} T
 * @param {T[]} list
 * @returns {T[]}
 */
export function byRank(list) {
  return [...list].sort(
    (a, b) => b.score.total - a.score.total || b.project.submitted - a.project.submitted,
  );
}

/**
 * The band a score falls in, for the tracker (4.5): 0–39, 40–69, 70–100.
 * @param {number} total
 * @returns {'0–39' | '40–69' | '70–100'}
 */
export function band(total) {
  if (total >= 70) return '70–100';
  if (total >= 40) return '40–69';
  return '0–39';
}
