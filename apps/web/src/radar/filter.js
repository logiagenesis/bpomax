// @ts-check
/**
 * The feed's saved filters (LI-PROMPT-BPOMAX-RADAR-20260927, 4.1), applied in the browser
 * to what the search returned.
 */
import { topUsd } from './freelancer.js';

/**
 * @typedef {import('./freelancer.js').Project} Project
 * @typedef {import('./store.js').Filters} Filters
 */

/**
 * The words in the exclude box: comma-separated, trimmed, any case, blanks dropped.
 * @param {string} text
 */
export function excludedWords(text) {
  return text
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {Project[]} projects
 * @param {Filters} filters
 * @param {{ acted: Set<number>, now: number }} context `acted`: bid on or dismissed
 * @returns {Project[]}
 */
export function applyFilters(projects, filters, context) {
  const words = excludedWords(filters.excludeWords);
  return projects.filter((project) => {
    if (filters.type !== 'both' && project.type !== filters.type) return false;
    const usd = topUsd(project) ?? 0;
    if (project.type === 'fixed' && filters.minBudgetUsd !== null && usd < filters.minBudgetUsd) {
      return false;
    }
    if (project.type === 'hourly' && filters.minHourlyUsd !== null && usd < filters.minHourlyUsd) {
      return false;
    }
    if (filters.maxBids !== null && project.bidCount > filters.maxBids) return false;
    if (
      filters.maxAgeHours !== null &&
      context.now - project.submitted > filters.maxAgeHours * 3_600_000
    ) {
      return false;
    }
    const title = project.title.toLowerCase();
    if (words.some((word) => title.includes(word))) return false;
    if (filters.hideActed && context.acted.has(project.id)) return false;
    return true;
  });
}
