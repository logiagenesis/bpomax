import { liveGate, minorToCsvAmount, toMinor } from '@arbitron/core';
import { recordEvent, textFingerprint, type Queryable } from '@arbitron/db';
import {
  AccountNotConnectedError,
  FreelancerError,
  createProject,
  findCurrencyId,
  findJobIds,
  freelancerAccessToken,
  listProjectBids,
  type Fetch,
  type FreelancerConfig,
} from '@arbitron/freelancer';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { enqueueReprice } from './reprice.js';

/**
 * The sourcing worker's marketplace half (ARB-203, docs/01 section E: "after approval
 * posts on Freelancer.com as an employer project (LIVE_MODE only); collects candidate
 * bids into supplier_candidates"). In order, for a post: it must be an approved
 * Freelancer.com post with a budget, not yet posted; the live gate (D-032), which with
 * either switch off leaves it unposted and writes what would have gone to the audit
 * log; the connected account and its token; the platform's id for the currency and the
 * skill named as the brief's category; then the documented create call.
 *
 * Collecting reads the project's bids and stores each once per request, with the
 * bidder's country and the quoted price in minor units, and updates it when read again.
 * Nothing here awards, pays or messages anyone.
 */
export const SOURCING_COLLECT_SCHEDULER_ID = 'sourcing-collect';
/** Bids on a sourcing project are read every half hour while the request is open. */
export const SOURCING_COLLECT_EVERY_MS = 30 * 60_000;
export const CREATE_PROJECT_CALL = 'projects/0.1/projects';
export const PROJECT_BIDS_CALL = 'projects/0.1/projects/{project_id}/bids';

export type SourcingJobData =
  | { readonly kind: 'post'; readonly postId: string; readonly requestId?: string }
  | { readonly kind: 'collect'; readonly postId: string; readonly requestId?: string }
  | { readonly kind: 'collect-all' };

export interface SourcingDeps {
  /** A service-role connection: the worker acts for whichever org owns the post. */
  readonly db: Queryable;
  readonly liveMode: boolean;
  readonly config: FreelancerConfig | null;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** Where a new or changed quote goes to be priced (ARB-204). Absent, bids are stored only. */
  readonly repriceQueue?: Queue;
}

export type PostResult =
  | { readonly status: 'posted'; readonly externalId: string }
  | { readonly status: 'already_posted'; readonly externalId: string | null }
  | {
      readonly status: 'skipped';
      readonly reason: 'not_approved' | 'not_freelancer';
      readonly message: string;
    }
  | { readonly status: 'blocked'; readonly reason: 'live_mode_off'; readonly message: string }
  | {
      readonly status: 'failed';
      readonly reason:
        'no_budget' | 'no_account' | 'no_client' | 'no_currency' | 'no_skill' | 'refused';
      readonly message: string;
    };

export interface CollectResult {
  readonly status: 'collected' | 'skipped';
  readonly added: number;
  readonly updated: number;
  readonly message?: string;
}

interface PostRow {
  id: string;
  org_id: string;
  sourcing_request_id: string;
  platform: string;
  title: string;
  body: string;
  budget_min_minor: string | null;
  budget_max_minor: string | null;
  currency: string | null;
  status: string;
  approved_by: string | null;
  external_id: string | null;
  category_name: string | null;
  request_status: string;
}

async function loadPost(db: Queryable, postId: string): Promise<PostRow> {
  const { rows } = await db.query<PostRow>(
    `select p.id, p.org_id, p.sourcing_request_id, p.platform::text as platform, p.title, p.body,
            p.budget_min_minor::text as budget_min_minor, p.budget_max_minor::text as budget_max_minor,
            p.currency::text as currency, p.status::text as status, p.approved_by, p.external_id,
            c.name as category_name, r.status::text as request_status
       from sourcing_posts p
       join sourcing_requests r on r.id = p.sourcing_request_id
       join briefs b on b.id = r.brief_id
       left join service_categories c on c.slug = b.category_slug
      where p.id = $1`,
    [postId],
  );
  const post = rows[0];
  if (!post) throw new UnrecoverableError(`sourcing post ${postId} does not exist`);
  return { ...post, currency: post.currency?.trim() ?? null };
}

/** Whole minor units as the currency's units for the API, which takes 250 for R250,00. */
function units(minor: string, currency: string): number {
  return Number(minorToCsvAmount(minor, currency));
}

async function tokenFor(
  deps: SourcingDeps,
  orgId: string,
  now: Date,
): Promise<
  { ok: true; token: string } | { ok: false; reason: 'no_account' | 'no_client'; message: string }
> {
  const accounts = await deps.db.query<{ id: string }>(
    `select id from platform_accounts where org_id = $1 and platform = 'freelancer' and status = 'connected'`,
    [orgId],
  );
  const account = accounts.rows[0];
  if (!account)
    return {
      ok: false,
      reason: 'no_account',
      message:
        'No Freelancer.com account is connected. Connect one in Settings and approve the post again.',
    };
  if (!deps.config)
    return {
      ok: false,
      reason: 'no_client',
      message: 'Freelancer.com is not configured (docs/02 B-03), so nothing can be posted.',
    };
  try {
    const token = await freelancerAccessToken(
      {
        db: deps.db,
        config: deps.config,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        now: () => now,
      },
      account.id,
    );
    return { ok: true, token };
  } catch (error) {
    if (error instanceof AccountNotConnectedError)
      return { ok: false, reason: 'no_account', message: error.message };
    throw error;
  }
}

export async function postSourcingProject(
  deps: SourcingDeps,
  data: { readonly postId: string; readonly requestId?: string },
): Promise<PostResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;
  const post = await loadPost(db, data.postId);

  const note = (
    outcome: 'ok' | 'blocked' | 'skipped' | 'error',
    payload: Record<string, unknown>,
  ) =>
    recordEvent(db, {
      orgId: post.org_id,
      type: 'sourcing.posted',
      actorKind: 'system',
      subjectTable: 'sourcing_posts',
      subjectId: post.id,
      requestId,
      outcome,
      payload: { via: 'api', sourcing_request_id: post.sourcing_request_id, ...payload },
    });

  if (post.external_id) return { status: 'already_posted', externalId: post.external_id };
  if (post.platform !== 'freelancer') {
    const message =
      'Only Freelancer.com posts are made through the API; this one is posted by hand.';
    await note('skipped', { reason: 'not_freelancer', message });
    return { status: 'skipped', reason: 'not_freelancer', message };
  }
  if (post.status !== 'approved' || !post.approved_by) {
    const message =
      'This post is not approved, so it is not posted. Approve it on the sourcing page.';
    await note('skipped', { reason: 'not_approved', message });
    return { status: 'skipped', reason: 'not_approved', message };
  }

  const fail = async (
    reason: Extract<PostResult, { status: 'failed' }>['reason'],
    message: string,
  ): Promise<PostResult> => {
    await db.query(
      `update sourcing_posts set status = 'failed', failure_reason = $2 where id = $1`,
      [post.id, message],
    );
    await note('error', { reason, message });
    return { status: 'failed', reason, message };
  };

  const low = post.budget_min_minor ?? post.budget_max_minor;
  const high = post.budget_max_minor ?? post.budget_min_minor;
  if (!post.currency || low === null || high === null)
    return fail(
      'no_budget',
      'A Freelancer.com project needs a budget. Edit the post to add one and approve it again.',
    );

  const settings = await db.query<{ live_mode: boolean }>(
    'select live_mode from settings where org_id = $1',
    [post.org_id],
  );
  const gate = liveGate({
    envLiveMode: deps.liveMode,
    orgLiveMode: settings.rows[0]?.live_mode ?? false,
  });
  if (!gate.live) {
    const message = gate.message.replace('The bid that', 'The project that');
    await recordEvent(db, {
      orgId: post.org_id,
      type: 'external.blocked_by_live_mode',
      subjectTable: 'sourcing_posts',
      subjectId: post.id,
      requestId,
      outcome: 'blocked',
      payload: {
        closedBy: gate.closedBy,
        wouldSend: {
          call: CREATE_PROJECT_CALL,
          title: textFingerprint(post.title),
          description: textFingerprint(post.body),
          currency: post.currency,
          budget: { minimum: units(low, post.currency), maximum: units(high, post.currency) },
          skill: post.category_name,
        },
      },
    });
    await note('blocked', { reason: 'live_mode_off', message, closedBy: gate.closedBy });
    return { status: 'blocked', reason: 'live_mode_off', message };
  }

  const token = await tokenFor(deps, post.org_id, now);
  if (!token.ok) return fail(token.reason, token.message);
  const config = deps.config as FreelancerConfig;
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};

  const external = async (outcome: 'ok' | 'error', payload: Record<string, unknown>) =>
    recordEvent(db, {
      orgId: post.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'sourcing_posts',
      subjectId: post.id,
      requestId,
      outcome,
      payload: { service: 'freelancer', ...payload },
    });

  try {
    const currencyId = await findCurrencyId(config, token.token, post.currency, fetchDeps);
    if (currencyId === null)
      return fail(
        'no_currency',
        `Freelancer.com lists no currency ${post.currency}, so the project is not posted.`,
      );
    const skill = post.category_name;
    const jobIds = skill ? await findJobIds(config, token.token, [skill], fetchDeps) : [];
    if (jobIds.length === 0)
      return fail(
        'no_skill',
        `Freelancer.com lists no skill named “${skill ?? 'none'}”, so the project is not posted. The post's skill is the brief's category name (D-055).`,
      );
    const created = await createProject(
      config,
      token.token,
      {
        title: post.title,
        description: post.body,
        currencyId,
        budget: { minimum: units(low, post.currency), maximum: units(high, post.currency) },
        jobIds,
      },
      fetchDeps,
    );
    await external('ok', {
      call: CREATE_PROJECT_CALL,
      request_id: created.requestId,
      rate_limit: created.rateLimit,
    });
    await db.query(
      `update sourcing_posts set status = 'posted', external_id = $2, posted_at = $3, failure_reason = null where id = $1`,
      [post.id, created.id, now.toISOString()],
    );
    // The platform's echo of the title and its slug stay out of the log (P-02).
    await note('ok', { external_id: created.id });
    return { status: 'posted', externalId: created.id };
  } catch (error) {
    if (!(error instanceof FreelancerError)) throw error;
    await external('error', {
      call: CREATE_PROJECT_CALL,
      status: error.status,
      error_code: error.errorCode,
      request_id: error.requestId,
      rate_limit: error.rateLimit ?? null,
    });
    const final =
      error.isAuthFailure || (error.status >= 400 && error.status < 500 && !error.isRateLimited);
    if (final) {
      await fail('refused', `${error.message}. Edit the post and approve it again.`);
      throw new UnrecoverableError(error.message);
    }
    await note('error', { reason: 'retry', message: error.message, status: error.status });
    throw error;
  }
}

/** Reads the project's bids into candidates: new ones added, known ones brought up to date. */
export async function collectSourcingBids(
  deps: SourcingDeps,
  data: { readonly postId: string; readonly requestId?: string },
): Promise<CollectResult> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const requestId = data.requestId ?? null;
  const post = await loadPost(db, data.postId);
  if (
    post.platform !== 'freelancer' ||
    post.status !== 'posted' ||
    !post.external_id ||
    !post.currency
  ) {
    return {
      status: 'skipped',
      added: 0,
      updated: 0,
      message: 'Only a posted Freelancer.com project has bids to read.',
    };
  }
  const token = await tokenFor(deps, post.org_id, now);
  if (!token.ok) return { status: 'skipped', added: 0, updated: 0, message: token.message };
  const config = deps.config as FreelancerConfig;
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};

  let added = 0;
  let updated = 0;
  let offset = 0;
  for (;;) {
    let page;
    try {
      page = await listProjectBids(
        config,
        token.token,
        post.external_id,
        { limit: 100, offset },
        fetchDeps,
      );
    } catch (error) {
      if (!(error instanceof FreelancerError)) throw error;
      await recordEvent(db, {
        orgId: post.org_id,
        type: 'external.call',
        actorKind: 'system',
        subjectTable: 'sourcing_posts',
        subjectId: post.id,
        requestId,
        outcome: 'error',
        payload: {
          service: 'freelancer',
          call: PROJECT_BIDS_CALL,
          status: error.status,
          error_code: error.errorCode,
        },
      });
      throw error;
    }
    await recordEvent(db, {
      orgId: post.org_id,
      type: 'external.call',
      actorKind: 'system',
      subjectTable: 'sourcing_posts',
      subjectId: post.id,
      requestId,
      outcome: 'ok',
      payload: {
        service: 'freelancer',
        call: PROJECT_BIDS_CALL,
        request_id: page.requestId,
        bids: page.bids.length,
      },
    });
    for (const bid of page.bids) {
      const name = bid.bidderUsername ?? `Freelancer.com bidder ${bid.bidderId}`;
      const price = String(toMinor(bid.amount, post.currency));
      const previous = await db.query<{ quoted_price_minor: string | null }>(
        `select quoted_price_minor::text as quoted_price_minor from supplier_candidates
          where sourcing_request_id = $1 and external_bid_id = $2`,
        [post.sourcing_request_id, bid.id],
      );
      const { rows } = await db.query<{ id: string; inserted: boolean }>(
        `insert into supplier_candidates (org_id, sourcing_request_id, sourcing_post_id, external_bid_id, display_name,
                                          country_code, quoted_price_minor, currency, turnaround_days)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (sourcing_request_id, external_bid_id) where external_bid_id is not null do update set
           display_name = excluded.display_name, country_code = excluded.country_code,
           quoted_price_minor = excluded.quoted_price_minor, turnaround_days = excluded.turnaround_days
         returning id, (xmax = 0) as inserted`,
        [
          post.org_id,
          post.sourcing_request_id,
          post.id,
          bid.id,
          name,
          bid.bidderCountryCode,
          price,
          post.currency,
          bid.period === null ? null : Math.max(0, Math.round(bid.period)),
        ],
      );
      const row = rows[0];
      if (!row) continue;
      if (row.inserted) {
        added += 1;
        await recordEvent(db, {
          orgId: post.org_id,
          type: 'supplier.candidate_added',
          actorKind: 'system',
          subjectTable: 'supplier_candidates',
          subjectId: row.id,
          requestId,
          payload: {
            via: 'freelancer',
            sourcing_request_id: post.sourcing_request_id,
            external_bid_id: bid.id,
            country_code: bid.bidderCountryCode,
            quoted_price_minor: price,
            currency: post.currency,
          },
        });
      } else updated += 1;
      // A new bid, or a bidder who changed their price, is priced against the job (ARB-204).
      if (deps.repriceQueue && (row.inserted || previous.rows[0]?.quoted_price_minor !== price)) {
        await enqueueReprice(deps.repriceQueue, {
          candidateId: row.id,
          quoteMinor: price,
          ...(requestId ? { requestId } : {}),
        });
      }
    }
    if (page.bids.length < 100) break;
    offset += 100;
  }
  return { status: 'collected', added, updated };
}

/** Every posted Freelancer.com project whose request is still open. */
export async function collectAllSourcingBids(deps: SourcingDeps): Promise<{ posts: number }> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select p.id from sourcing_posts p join sourcing_requests r on r.id = p.sourcing_request_id
      where p.platform = 'freelancer' and p.status = 'posted' and p.external_id is not null
        and r.status in ('open', 'shortlisting')`,
  );
  for (const row of rows) await collectSourcingBids(deps, { postId: row.id });
  return { posts: rows.length };
}

export function sourcingProcessor(deps: SourcingDeps) {
  return async (job: Job<SourcingJobData>) => {
    if (job.data.kind === 'post') return postSourcingProject(deps, job.data);
    if (job.data.kind === 'collect') return collectSourcingBids(deps, job.data);
    return collectAllSourcingBids(deps);
  };
}

/** One post per approval: BullMQ drops an add whose id is already queued. */
export function enqueueSourcingPost(queue: Queue, data: { postId: string; requestId?: string }) {
  return queue.add('post', { kind: 'post', ...data } satisfies SourcingJobData, {
    jobId: `sourcing-post__${data.postId}`,
  });
}

export function enqueueSourcingCollect(queue: Queue, data: { postId: string; requestId?: string }) {
  return queue.add('collect', { kind: 'collect', ...data } satisfies SourcingJobData);
}

export async function scheduleSourcingCollect(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SOURCING_COLLECT_SCHEDULER_ID,
    { every: SOURCING_COLLECT_EVERY_MS },
    { name: 'collect-all', data: { kind: 'collect-all' } satisfies SourcingJobData },
  );
}
