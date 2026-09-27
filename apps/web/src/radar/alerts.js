// @ts-check
/**
 * Alerts (LI-PROMPT-BPOMAX-RADAR-20260927, 4.7): which projects in a fresh read deserve a
 * browser notification. A project does when it scores at or above the owner's threshold,
 * was posted under 15 minutes ago, and has not been notified before. The page shows the
 * notifications; this only chooses them.
 */

/** Only projects younger than this are news. */
const FRESH_MS = 15 * 60_000;

/** The most notified ids kept, newest last, so the list never grows without end. */
export const NOTIFIED_KEPT = 500;

/**
 * @template {{ project: import('./freelancer.js').Project, score: { total: number } }} T
 * @param {T[]} ranked
 * @param {{ threshold: number, notified: Set<number>, now: number }} context
 * @returns {T[]}
 */
export function pickAlerts(ranked, context) {
  return ranked.filter(
    ({ project, score }) =>
      score.total >= context.threshold &&
      context.now - project.submitted < FRESH_MS &&
      !context.notified.has(project.id),
  );
}
