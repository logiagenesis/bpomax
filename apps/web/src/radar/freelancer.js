// @ts-check
/**
 * Freelancer.com's public API, read straight from the browser (LI-PROMPT-BPOMAX-RADAR-20260927,
 * facts F1–F7). No key and no sign-in: the project search, the skills list and the
 * freelancer directory answer anyone, with `access-control-allow-origin: *`. Unsigned calls
 * carry nothing about the client (F7), so nothing here reads or depends on one.
 */
import { FREELANCER } from './links.js';

export const API = `${FREELANCER}/api`;
const PAGE = 100;
/** The most projects one refresh reads: three pages. */
export const MAX_PROJECTS = 300;

/**
 * @typedef {import('./store.js').Skill} Skill
 * @typedef {object} Project
 * @property {number} id
 * @property {string} title
 * @property {string} description
 * @property {string} url the project's page on Freelancer.com
 * @property {'fixed' | 'hourly'} type
 * @property {string} currency ISO code
 * @property {number} usdRate one unit of the currency in USD (F4)
 * @property {number | null} budgetMin in the project's currency (per hour when hourly)
 * @property {number | null} budgetMax
 * @property {number} bidCount
 * @property {number | null} bidAvg in the project's currency
 * @property {number} submitted epoch milliseconds
 * @property {Skill[]} skills
 * @property {{ nda: boolean, sealed: boolean, urgent: boolean, featured: boolean }} upgrades
 */

/** An answer from Freelancer.com that is not a success, or no answer at all. */
export class FreelancerError extends Error {
  /**
   * @param {string} message
   * @param {number | null} status the HTTP status, or null when nothing came back
   */
  constructor(message, status) {
    super(message);
    this.name = 'FreelancerError';
    this.status = status;
  }
}

/**
 * The active-project search, newest first, one page of it (F1, F3).
 * @param {number[]} skillIds one `jobs[]` each; none reads every project
 * @param {number} offset
 */
export function projectsUrl(skillIds, offset) {
  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
    full_description: 'true',
    job_details: 'true',
    sort_field: 'time_submitted',
  });
  for (const id of skillIds) params.append('jobs[]', String(id));
  return `${API}/projects/0.1/projects/active/?${params.toString()}`;
}

const SKILLS_URL = `${API}/projects/0.1/jobs/`;

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * One project from the search, in the shape the page uses.
 * @param {any} raw
 * @returns {Project}
 */
export function normaliseProject(raw) {
  const upgrades = raw.upgrades ?? {};
  return {
    id: Number(raw.id),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? raw.preview_description ?? ''),
    url: `${FREELANCER}/projects/${String(raw.seo_url ?? raw.id)}`,
    type: raw.type === 'hourly' ? 'hourly' : 'fixed',
    currency: String(raw.currency?.code ?? 'USD'),
    usdRate: num(raw.currency?.exchange_rate) ?? 1,
    budgetMin: num(raw.budget?.minimum),
    budgetMax: num(raw.budget?.maximum),
    bidCount: num(raw.bid_stats?.bid_count) ?? 0,
    bidAvg: num(raw.bid_stats?.bid_avg),
    submitted: (num(raw.time_submitted) ?? 0) * 1000,
    skills: Array.isArray(raw.jobs)
      ? raw.jobs.map((/** @type {any} */ job) => ({ id: Number(job.id), name: String(job.name) }))
      : [],
    upgrades: {
      nda: upgrades.NDA === true,
      sealed: upgrades.sealed === true,
      urgent: upgrades.urgent === true,
      featured: upgrades.featured === true,
    },
  };
}

/**
 * GETs a Freelancer.com API URL and returns its `result`.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 */
export async function getResult(url, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new FreelancerError(
      `Could not reach Freelancer.com (${error instanceof Error ? error.message : String(error)}).`,
      null,
    );
  }
  /** @type {any} */
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Handled below: a body that is not JSON is an error whatever the status.
  }
  if (!response.ok || body?.status !== 'success') {
    const said = typeof body?.message === 'string' ? `: ${body.message}` : '';
    throw new FreelancerError(
      `Freelancer.com answered HTTP ${String(response.status)}${said}.`,
      response.status,
    );
  }
  return body.result;
}

/**
 * Up to 300 active projects, newest first, in pages of 100. A project that moves across
 * a page boundary while the pages are read appears once.
 * @param {number[]} skillIds
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Project[]>}
 */
export async function fetchProjects(skillIds, fetchImpl = fetch) {
  /** @type {Map<number, Project>} */
  const seen = new Map();
  for (let offset = 0; offset < MAX_PROJECTS; offset += PAGE) {
    const result = await getResult(projectsUrl(skillIds, offset), fetchImpl);
    const page = Array.isArray(result?.projects) ? result.projects : [];
    for (const raw of page) {
      const project = normaliseProject(raw);
      if (!seen.has(project.id)) seen.set(project.id, project);
    }
    if (page.length < PAGE) break;
  }
  return [...seen.values()];
}

/**
 * Every skill on Freelancer.com (F3), as id and name.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Skill[]>}
 */
export async function fetchSkills(fetchImpl = fetch) {
  const result = await getResult(SKILLS_URL, fetchImpl);
  return (Array.isArray(result) ? result : [])
    .map((/** @type {any} */ job) => ({ id: Number(job.id), name: String(job.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
}

/**
 * How long to wait before the next read: the owner's refresh interval, or after a failure
 * 4, 8, 16 minutes, then 30 at most, however short the interval, since the limit on
 * unsigned calls is not published. Null when refresh is manual: nothing is read on its own.
 * @param {number} failures reads that have failed in a row
 * @param {number} refreshMinutes 0 = manual
 * @returns {number | null} milliseconds
 */
export function nextDelayMs(failures, refreshMinutes) {
  if (refreshMinutes <= 0) return null;
  if (failures > 0) return Math.min(4 * 2 ** (failures - 1), 30) * 60_000;
  return refreshMinutes * 60_000;
}

/**
 * The most the client will pay, in USD: the budget's maximum, or its minimum when no
 * maximum is given, times the currency's rate (F4). Per hour for an hourly project.
 * @param {Project} project
 * @returns {number | null}
 */
export function topUsd(project) {
  const top = project.budgetMax ?? project.budgetMin;
  return top === null ? null : top * project.usdRate;
}
