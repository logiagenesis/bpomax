import { toMinor, type ScannerFilters } from '@arbitron/core';
import { inTransaction, recordEvent, type Queryable } from '@arbitron/db';
import {
  AccountNotConnectedError,
  FreelancerError,
  freelancerAccessToken,
  searchActiveProjects,
  type ActiveProjectQuery,
  type Fetch,
  type FreelancerConfig,
  type FreelancerProject,
} from '@arbitron/freelancer';
import type { Job, Queue } from 'bullmq';
import { enqueueScore } from './score.js';

/**
 * The ingest worker (ARB-022, docs/01 section E): "per scanner interval — calls
 * Freelancer.com project search with scanner filters; upserts; enqueues score for new
 * jobs". Two kinds of job run on the `ingest` queue:
 *
 * - `sync`, every minute from one fixed scheduler: reads the active Freelancer.com
 *   scanners whose org has a connected account and keeps one BullMQ job scheduler per
 *   scanner, at the scanner's own interval. Adding, editing, pausing or deleting a
 *   scanner in Settings therefore takes effect within a minute, with nothing for the API
 *   to tell Redis (D-045).
 * - `poll`, per scanner at its interval: one call to the documented search
 *   (`@arbitron/freelancer`, `searchActiveProjects`), an upsert per listing on the org's
 *   dedupe key (0018), a `job.ingested` event and a score job for each listing that is
 *   new, and a `scanner.polled` event for the run.
 *
 * Rate limits (docs/05 section 4.5): a 429 is logged as `external.call` with the error
 * code and the `RateLimit-*` headers, and the job is thrown back to the queue, whose
 * exponential backoff (5 s doubling, ARB-030) is the wait. A refused token (401, 403)
 * marks the account `expired` and is not retried: the owner connects again in Settings.
 *
 * Every call carries no token in any event or return value.
 */
export const INGEST_SYNC_SCHEDULER_ID = 'ingest-sync';
export const INGEST_SYNC_EVERY_MS = 60_000;
export const SCANNER_SCHEDULER_PREFIX = 'scanner:';
export const FREELANCER_SEARCH_CALL = 'projects/0.1/projects/active';

export type IngestJobData =
  | { readonly kind: 'sync' }
  | { readonly kind: 'poll'; readonly scannerId: string; readonly requestId?: string };

export function scannerSchedulerId(scannerId: string): string {
  return `${SCANNER_SCHEDULER_PREFIX}${scannerId}`;
}

/** Creates the minute-by-minute sync, or leaves the one that exists as it is. */
export async function scheduleIngestSync(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    INGEST_SYNC_SCHEDULER_ID,
    { every: INGEST_SYNC_EVERY_MS },
    { name: 'sync', data: { kind: 'sync' } satisfies IngestJobData },
  );
}

export interface IngestDeps {
  /** A service-role connection: the worker acts for whichever org owns the scanner. */
  readonly db: Queryable;
  /** The `ingest` queue itself, whose schedulers the sync keeps. */
  readonly queue: Queue;
  /** `freelancerConfig(process.env)` when ok; null leaves every scanner unscheduled. */
  readonly config: FreelancerConfig | null;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** Where a new listing goes next (01 section E). Optional so a poll can run alone. */
  readonly scoreQueue?: Queue;
}

export interface IngestSync {
  readonly wanted: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly reason?: string;
}

interface ScheduleRow {
  id: string;
  poll_interval_seconds: number;
}

export async function syncIngestSchedules(deps: IngestDeps): Promise<IngestSync> {
  const existing = new Map<string, string | undefined>();
  for (const scheduler of await deps.queue.getJobSchedulers()) {
    if (scheduler.key.startsWith(SCANNER_SCHEDULER_PREFIX)) {
      existing.set(
        scheduler.key,
        scheduler.every === undefined ? undefined : String(scheduler.every),
      );
    }
  }

  const wanted = new Map<string, number>();
  if (deps.config) {
    const { rows } = await deps.db.query<ScheduleRow>(
      `select s.id, s.poll_interval_seconds
         from scanners s
        where s.active and s.platform = 'freelancer'
          and exists (select 1 from platform_accounts a
                       where a.org_id = s.org_id and a.platform = 'freelancer'
                         and a.status = 'connected')`,
    );
    for (const row of rows)
      wanted.set(scannerSchedulerId(row.id), row.poll_interval_seconds * 1000);
  }

  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [key, every] of wanted) {
    const current = existing.get(key);
    if (current === String(every)) continue;
    if (existing.has(key)) changed += 1;
    else added += 1;
    const scannerId = key.slice(SCANNER_SCHEDULER_PREFIX.length);
    await deps.queue.upsertJobScheduler(
      key,
      { every },
      { name: 'poll', data: { kind: 'poll', scannerId } satisfies IngestJobData },
    );
  }
  for (const key of existing.keys()) {
    if (wanted.has(key)) continue;
    await deps.queue.removeJobScheduler(key);
    removed += 1;
  }
  return {
    wanted: wanted.size,
    added,
    changed,
    removed,
    ...(deps.config ? {} : { reason: 'Freelancer.com is not configured (docs/02 B-03)' }),
  };
}

export type IngestRun =
  | {
      readonly status: 'polled';
      readonly scannerId: string;
      readonly orgId: string;
      readonly fetched: number;
      readonly kept: number;
      readonly created: number;
      readonly updated: number;
      readonly totalCount: number | null;
      readonly requestId: string | null;
    }
  | { readonly status: 'skipped'; readonly scannerId: string; readonly reason: string }
  | {
      readonly status: 'auth_failed';
      readonly scannerId: string;
      readonly orgId: string;
      readonly reason: string;
    };

interface ScannerRow {
  id: string;
  org_id: string;
  name: string;
  filters: ScannerFilters;
  active: boolean;
  platform: string;
  account_id: string | null;
  account_status: string | null;
}

/** Whole cents as the decimal text the `min_price` parameter takes (USD only). */
export function usdText(minor: number): string {
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${String(whole)}.${String(cents).padStart(2, '0')}`;
}

export interface BuiltQuery {
  readonly query: ActiveProjectQuery;
  /** Applied here, to what comes back, because the endpoint has no such parameter. */
  readonly keep: (project: FreelancerProject) => boolean;
  /** Scanner filters the endpoint cannot express and the listing cannot answer. */
  readonly notApplied: readonly string[];
}

/**
 * The scanner's filters as the documented parameters (`projects.ts` cites each), and what
 * remains to be done locally:
 *
 * - `budgetMinMinor` in USD is `min_price`, which the docs define in USD. In any other
 *   currency it is applied here to listings priced in that same currency; a listing in
 *   another currency is kept, since comparing them needs a rate the worker does not have.
 * - `clientCountriesExclude`: the endpoint filters by country only inclusively, and the
 *   listing carries no client country, so it is not applied and the run says so.
 * - `categorySlugs`: the org's own taxonomy; the estimate worker classifies each listing
 *   into it (ARB-040, 0012). Nothing here maps a slug to a Freelancer.com job id.
 */
export function buildQuery(filters: ScannerFilters): BuiltQuery {
  const notApplied: string[] = [];
  const query: {
    -readonly [K in keyof ActiveProjectQuery]: ActiveProjectQuery[K];
  } = {};
  const keywords = (filters.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > 0) query.query = keywords.join(' ');
  if (filters.hourly === true) query.projectTypes = ['hourly'];
  if (filters.hourly === false) query.projectTypes = ['fixed'];
  if (filters.clientCountriesInclude && filters.clientCountriesInclude.length > 0) {
    query.countries = filters.clientCountriesInclude;
  }
  let keep: (project: FreelancerProject) => boolean = () => true;
  if (filters.budgetMinMinor !== undefined) {
    const currency = filters.currency?.toUpperCase();
    if (currency === 'USD') {
      query.minPriceUsd = usdText(filters.budgetMinMinor);
    } else if (currency) {
      const floor = filters.budgetMinMinor;
      keep = (project) =>
        project.currencyCode !== currency ||
        project.budgetMinimum === null ||
        toMinor(project.budgetMinimum, currency) >= floor;
    } else {
      notApplied.push('budgetMinMinor');
    }
  }
  if (filters.clientCountriesExclude && filters.clientCountriesExclude.length > 0) {
    notApplied.push('clientCountriesExclude');
  }
  if (filters.categorySlugs && filters.categorySlugs.length > 0) notApplied.push('categorySlugs');
  return { query, keep, notApplied };
}

const CURRENCY = /^[A-Z]{3}$/;

interface UpsertedJob {
  id: string;
  inserted: boolean;
}

/**
 * One row per listing per org (0018). A listing seen again refreshes what the
 * marketplace changes (bids, budget, title, text) and keeps what the org added to it
 * (its scanner, its category). The average bid is kept in `raw` only: the docs do not
 * say which currency `bid_stats.bid_avg` is in, so no minor-unit figure is made of it.
 */
async function upsertJob(
  db: Queryable,
  scanner: ScannerRow,
  project: FreelancerProject,
): Promise<UpsertedJob> {
  const currency =
    project.currencyCode && CURRENCY.test(project.currencyCode) ? project.currencyCode : null;
  let min =
    currency && project.budgetMinimum !== null ? toMinor(project.budgetMinimum, currency) : null;
  let max =
    currency && project.budgetMaximum !== null ? toMinor(project.budgetMaximum, currency) : null;
  if (min !== null && min < 0) min = null;
  if (max !== null && (max < 0 || (min !== null && max < min))) max = null;
  const bidCount =
    project.bidCount !== null && Number.isInteger(project.bidCount) && project.bidCount >= 0
      ? project.bidCount
      : null;
  const { rows } = await db.query<UpsertedJob>(
    `insert into jobs
       (org_id, scanner_id, platform, external_id, raw, title, description,
        budget_min_minor, budget_max_minor, currency, hourly, skills, bid_count, posted_at)
     values ($1, $2, 'freelancer', $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (org_id, platform, external_id) do update
       set raw = excluded.raw,
           title = excluded.title,
           description = coalesce(excluded.description, jobs.description),
           budget_min_minor = excluded.budget_min_minor,
           budget_max_minor = excluded.budget_max_minor,
           currency = excluded.currency,
           hourly = excluded.hourly,
           skills = excluded.skills,
           bid_count = excluded.bid_count,
           posted_at = coalesce(excluded.posted_at, jobs.posted_at)
     returning id, (xmax = 0) as inserted`,
    [
      scanner.org_id,
      scanner.id,
      project.id,
      JSON.stringify(project.raw),
      project.title,
      project.description,
      min,
      max,
      currency,
      project.type === 'hourly',
      project.skills,
      bidCount,
      project.submittedAt?.toISOString() ?? null,
    ],
  );
  return rows[0]!;
}

export async function pollScanner(
  deps: IngestDeps,
  data: { readonly scannerId: string; readonly requestId?: string },
): Promise<IngestRun> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;

  const { rows } = await db.query<ScannerRow>(
    `select s.id, s.org_id, s.name, s.filters, s.active, s.platform::text as platform,
            a.id as account_id, a.status::text as account_status
       from scanners s
       left join platform_accounts a on a.org_id = s.org_id and a.platform = 'freelancer'
      where s.id = $1`,
    [data.scannerId],
  );
  const scanner = rows[0];
  if (!scanner || !scanner.active || scanner.platform !== 'freelancer') {
    // Its schedule is stale; the sync would remove it within a minute, this does it now.
    await deps.queue.removeJobScheduler(scannerSchedulerId(data.scannerId));
    return {
      status: 'skipped',
      scannerId: data.scannerId,
      reason: !scanner
        ? 'the scanner no longer exists'
        : !scanner.active
          ? 'the scanner is inactive'
          : `the scanner is for ${scanner.platform}, which has no ingest yet`,
    };
  }

  const polled = (
    outcome: 'ok' | 'error' | 'skipped',
    payload: Record<string, unknown>,
    on: Queryable = db,
  ): Promise<string> =>
    recordEvent(on, {
      orgId: scanner.org_id,
      type: 'scanner.polled',
      actorKind: 'system',
      subjectTable: 'scanners',
      subjectId: scanner.id,
      requestId,
      outcome,
      payload: { scanner_name: scanner.name, ...payload },
    });
  const skip = async (reason: string): Promise<IngestRun> => {
    await polled('skipped', { reason });
    return { status: 'skipped', scannerId: scanner.id, reason };
  };

  if (!deps.config) return skip('Freelancer.com is not configured (docs/02 B-03)');
  if (!scanner.account_id) {
    return skip('no Freelancer.com account is connected; connect one in Settings');
  }
  if (scanner.account_status !== 'connected') {
    return skip(
      `the Freelancer.com account is ${scanner.account_status ?? 'unknown'}; connect it again in Settings`,
    );
  }
  const config = deps.config;
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};

  let accessToken: string;
  try {
    accessToken = await freelancerAccessToken(
      { db, config, ...fetchDeps, now: () => now },
      scanner.account_id,
    );
  } catch (error) {
    if (error instanceof AccountNotConnectedError) return skip(error.message);
    if (error instanceof FreelancerError) {
      await polled('error', { reason: error.message, retry: true });
    }
    throw error;
  }

  const built = buildQuery(scanner.filters ?? {});
  let page;
  try {
    page = await searchActiveProjects(config, accessToken, built.query, fetchDeps);
  } catch (error) {
    if (!(error instanceof FreelancerError)) throw error;
    await recordEvent(db, {
      orgId: scanner.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'scanners',
      subjectId: scanner.id,
      requestId,
      outcome: 'error',
      payload: {
        service: 'freelancer',
        call: FREELANCER_SEARCH_CALL,
        status: error.status,
        error_code: error.errorCode,
        request_id: error.requestId,
        rate_limit: error.rateLimit ?? null,
      },
    });
    if (error.isAuthFailure) {
      await db.query(`update platform_accounts set status = 'expired' where id = $1`, [
        scanner.account_id,
      ]);
      const reason =
        'Freelancer.com refused the token, so the account is marked expired. Connect it again in Settings.';
      await polled('error', { reason, status: error.status, error_code: error.errorCode });
      return { status: 'auth_failed', scannerId: scanner.id, orgId: scanner.org_id, reason };
    }
    // A rate limit, a 5xx or a network failure: the queue's backoff is the wait.
    await polled('error', {
      reason: error.message,
      status: error.status,
      error_code: error.errorCode,
      retry: true,
    });
    throw error;
  }

  await recordEvent(db, {
    orgId: scanner.org_id,
    type: 'external.call',
    actorKind: 'system',
    subjectTable: 'scanners',
    subjectId: scanner.id,
    requestId,
    outcome: 'ok',
    payload: {
      service: 'freelancer',
      call: FREELANCER_SEARCH_CALL,
      request_id: page.requestId,
      total_count: page.totalCount,
      returned: page.projects.length,
      rate_limit: page.rateLimit,
    },
  });

  const kept = page.projects.filter(built.keep);
  const created: string[] = [];
  let updated = 0;
  await inTransaction(db, async (tx) => {
    for (const project of kept) {
      const row = await upsertJob(tx, scanner, project);
      if (!row.inserted) {
        updated += 1;
        continue;
      }
      created.push(row.id);
      await recordEvent(tx, {
        orgId: scanner.org_id,
        type: 'job.ingested',
        actorKind: 'system',
        subjectTable: 'jobs',
        subjectId: row.id,
        requestId,
        outcome: 'ok',
        payload: {
          scanner_id: scanner.id,
          platform: 'freelancer',
          external_id: project.id,
          title: project.title,
          hourly: project.type === 'hourly',
          currency: project.currencyCode,
          seo_url: project.seoUrl,
        },
      });
    }
    await tx.query(`update platform_accounts set last_sync_at = $2 where id = $1`, [
      scanner.account_id,
      now.toISOString(),
    ]);
    await polled(
      'ok',
      {
        fetched: page.projects.length,
        kept: kept.length,
        created: created.length,
        updated,
        total_count: page.totalCount,
        request_id: page.requestId,
        filters_not_applied: built.notApplied,
      },
      tx,
    );
  });

  // After the commit, so the score worker finds the rows it is told about.
  if (deps.scoreQueue) {
    for (const jobId of created) {
      await enqueueScore(deps.scoreQueue, { jobId, ...(requestId ? { requestId } : {}) });
    }
  }

  return {
    status: 'polled',
    scannerId: scanner.id,
    orgId: scanner.org_id,
    fetched: page.projects.length,
    kept: kept.length,
    created: created.length,
    updated,
    totalCount: page.totalCount,
    requestId: page.requestId,
  };
}

/** The processor for the `ingest` queue: the sync, or one scanner's poll. */
export function ingestProcessor(deps: IngestDeps) {
  return async (job: Job<IngestJobData>): Promise<IngestSync | IngestRun> => {
    if (job.data.kind === 'sync') return syncIngestSchedules(deps);
    return pollScanner(deps, {
      scannerId: job.data.scannerId,
      ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
    });
  };
}
