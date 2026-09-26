import { recordEvent, inTransaction, type Queryable } from '@arbitron/db';
import {
  DOC,
  UpworkAccountNotConnectedError,
  UpworkError,
  buildSearch,
  searchJobs,
  upworkAccessToken,
  type UpworkConfig,
  type UpworkJob,
} from '@arbitron/upwork';
import type { Queue } from 'bullmq';
import type { IngestRun, ScannerRow } from './ingest.js';
import { enqueueScore } from './score.js';

/**
 * The Upwork half of the ingest (ARB-300): read only, through the official GraphQL API
 * (`@arbitron/upwork`, every call cited there). docs/01 section B: Upwork is for finding
 * jobs; bids go through Upwork's own agency/Business Manager model, so nothing here or
 * downstream drafts or sends one (D-066), and no browser is ever driven.
 *
 * Upwork's terms allow no storing of their data for more than 24 hours (DOC.permissions:
 * "Caching is not allowed for more than 24 hours according to our Terms of Service"), so
 * `purgeUpworkJobs` deletes every Upwork job not fetched again within 24 hours, and runs
 * with the ingest's minute-by-minute sync.
 */
export const UPWORK_SEARCH_CALL = 'graphql marketplaceJobPostingsSearch';
export const UPWORK_KEEP_HOURS = 24;

export interface UpworkIngestDeps {
  readonly db: Queryable;
  readonly queue: Queue;
  readonly upwork: UpworkConfig | null;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly scoreQueue?: Queue;
}

const CURRENCY = /^[A-Z]{3}$/;

/** One row per listing per org (0018), refreshed on every fetch, with the fetch time. */
async function upsertUpworkJob(
  db: Queryable,
  scanner: ScannerRow,
  job: UpworkJob,
  fetchedAt: Date,
): Promise<{ id: string; inserted: boolean }> {
  const budget = job.hourly
    ? { min: job.hourlyMin, max: job.hourlyMax }
    : { min: job.fixed, max: job.fixed };
  const currencies = [budget.min?.currency, budget.max?.currency].filter(Boolean);
  const currency =
    currencies.length > 0 &&
    currencies.every((c) => c === currencies[0]) &&
    CURRENCY.test(currencies[0]!)
      ? currencies[0]!
      : null;
  let min = currency ? (budget.min?.minor ?? null) : null;
  let max = currency ? (budget.max?.minor ?? null) : null;
  if (min !== null && max !== null && max < min) [min, max] = [null, null];
  const spent =
    job.clientTotalSpent && job.clientTotalSpent.currency === currency
      ? job.clientTotalSpent.minor
      : null;
  const { rows } = await db.query<{ id: string; inserted: boolean }>(
    `insert into jobs
       (org_id, scanner_id, platform, external_id, raw, title, description,
        budget_min_minor, budget_max_minor, currency, hourly, skills, bid_count, posted_at,
        client_payment_verified, client_spend_minor, fetched_at)
     values ($1, $2, 'upwork', $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
           posted_at = coalesce(excluded.posted_at, jobs.posted_at),
           client_payment_verified = excluded.client_payment_verified,
           client_spend_minor = excluded.client_spend_minor,
           fetched_at = excluded.fetched_at
     returning id, (xmax = 0) as inserted`,
    [
      scanner.org_id,
      scanner.id,
      job.id,
      JSON.stringify(job.raw),
      job.title,
      job.description,
      min,
      max,
      currency,
      job.hourly,
      job.skills,
      job.applicants,
      job.publishedAt?.toISOString() ?? null,
      job.clientPaymentVerified,
      spent,
      fetchedAt.toISOString(),
    ],
  );
  return rows[0]!;
}

export async function pollUpworkScanner(
  deps: UpworkIngestDeps,
  scanner: ScannerRow,
  requestId: string | null,
): Promise<IngestRun> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const polled = (
    outcome: 'ok' | 'error' | 'skipped',
    payload: Record<string, unknown>,
    on: Queryable = db,
  ) =>
    recordEvent(on, {
      orgId: scanner.org_id,
      type: 'scanner.polled',
      actorKind: 'system',
      subjectTable: 'scanners',
      subjectId: scanner.id,
      requestId,
      outcome,
      payload: { scanner_name: scanner.name, platform: 'upwork', ...payload },
    });
  const skip = async (reason: string): Promise<IngestRun> => {
    await polled('skipped', { reason });
    return { status: 'skipped', scannerId: scanner.id, reason };
  };

  if (!deps.upwork) return skip('Upwork is not configured (docs/02 B-14)');
  if (!scanner.account_id) return skip('no Upwork account is connected; connect one in Settings');
  if (scanner.account_status !== 'connected')
    return skip(
      `the Upwork account is ${scanner.account_status ?? 'unknown'}; connect it again in Settings`,
    );
  const config = deps.upwork;
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};

  let accessToken: string;
  try {
    accessToken = await upworkAccessToken(
      { db, config, ...fetchDeps, now: () => now },
      scanner.account_id,
    );
  } catch (error) {
    if (error instanceof UpworkAccountNotConnectedError) return skip(error.message);
    if (error instanceof UpworkError) await polled('error', { reason: error.message, retry: true });
    throw error;
  }

  const built = buildSearch(scanner.filters ?? {});
  let page;
  try {
    page = await searchJobs(config, accessToken, built.filter, fetchDeps);
  } catch (error) {
    if (!(error instanceof UpworkError)) throw error;
    await recordEvent(db, {
      orgId: scanner.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'scanners',
      subjectId: scanner.id,
      requestId,
      outcome: 'error',
      payload: {
        service: 'upwork',
        call: UPWORK_SEARCH_CALL,
        doc: DOC.jobSearch,
        status: error.status,
        permission: error.permission,
        message: error.message,
      },
    });
    if (error.isAuthFailure) {
      await db.query(`update platform_accounts set status = 'expired' where id = $1`, [
        scanner.account_id,
      ]);
      const reason = error.permission
        ? 'Upwork says the API key lacks the "Read marketplace Job Postings" permission, so the account is marked expired. Add the permission to the key (docs/02 B-14), then connect again in Settings.'
        : 'Upwork refused the token, so the account is marked expired. Connect it again in Settings.';
      await polled('error', { reason, status: error.status });
      return { status: 'auth_failed', scannerId: scanner.id, orgId: scanner.org_id, reason };
    }
    // A rate limit ("300 requests per minute per IP address"), a 5xx or a network
    // failure: the queue's backoff is the wait.
    await polled('error', { reason: error.message, status: error.status, retry: true });
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
      service: 'upwork',
      call: UPWORK_SEARCH_CALL,
      doc: DOC.jobSearch,
      total_count: page.totalCount,
      returned: page.jobs.length,
    },
  });

  const kept = page.jobs.filter(built.keep);
  const created: string[] = [];
  let updated = 0;
  await inTransaction(db, async (tx) => {
    for (const job of kept) {
      const row = await upsertUpworkJob(tx, scanner, job, now);
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
          platform: 'upwork',
          external_id: job.id,
          // No title: the job row is purged after 24 hours (Upwork's terms, D-066), and a
          // copy here would outlive it (ARB-520, the owner's audit P-02).
          hourly: job.hourly,
          currency: job.fixed?.currency ?? job.hourlyMin?.currency ?? null,
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
        fetched: page.jobs.length,
        kept: kept.length,
        created: created.length,
        updated,
        total_count: page.totalCount,
        filters_not_applied: built.notApplied,
      },
      tx,
    );
  });

  if (deps.scoreQueue) {
    for (const jobId of created) {
      await enqueueScore(deps.scoreQueue, { jobId, ...(requestId ? { requestId } : {}) });
    }
  }
  return {
    status: 'polled',
    scannerId: scanner.id,
    orgId: scanner.org_id,
    fetched: page.jobs.length,
    kept: kept.length,
    created: created.length,
    updated,
    totalCount: page.totalCount,
    requestId: null,
  };
}

/**
 * Deletes every Upwork job not fetched again within the last 24 hours, with what hangs
 * off it (scores, estimates, margins: their foreign keys cascade), and logs how many per
 * organisation as `retention.purged` (D-066).
 */
export async function purgeUpworkJobs(db: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - UPWORK_KEEP_HOURS * 3_600_000);
  return inTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ org_id: string; n: number }>(
      `with gone as (
         delete from jobs where platform = 'upwork' and fetched_at < $1 returning org_id
       )
       select org_id, count(*)::int as n from gone group by org_id`,
      [cutoff.toISOString()],
    );
    for (const row of rows) {
      await recordEvent(tx, {
        orgId: row.org_id,
        type: 'retention.purged',
        actorKind: 'system',
        subjectTable: 'jobs',
        outcome: 'ok',
        payload: {
          platform: 'upwork',
          deleted: row.n,
          rule: 'Upwork data is not kept for more than 24 hours',
          source: DOC.permissions,
          cutoff: cutoff.toISOString(),
        },
      });
    }
    return rows.reduce((sum, r) => sum + r.n, 0);
  });
}
