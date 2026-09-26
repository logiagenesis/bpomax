import type { Queryable } from './client.js';
import { recordEvent, textFingerprint } from './events.js';
import { planUsage } from './plan-usage.js';

/**
 * Approving, editing and rejecting a bid (ARB-512, the owner's audit E-06): one module for
 * the web, MCP and Telegram, which had each grown their own copy and drifted (the bot
 * skipped the plan check on approval and changed a bid without checking what it had
 * become since it was read).
 *
 * Every change is one conditional update: it names the states it may move the bid from,
 * inside the org, and what it returns says whether it happened. Nothing is read first and
 * written after, so two people pressing at once, on the page and in Telegram, cannot both
 * succeed: the second is told what the first did. The event is written only when the
 * update took. The caller has already checked the person's role; row-level security holds
 * it again for a signed-in caller.
 */
export type BidChannel = 'web' | 'mcp' | 'telegram';

export interface BidActor {
  readonly orgId: string;
  readonly userId: string;
}

export type BidChange =
  | { readonly ok: true; readonly statusBefore: string }
  | {
      readonly ok: false;
      /**
       * 404 no such bid in the org; 409 its state does not allow it; 402 the plan has no
       * room; 403 the row-level security refused it (a role that may not change bids).
       */
      readonly code: 404 | 409 | 402 | 403;
      readonly message: string;
    };

async function currentStatus(db: Queryable, orgId: string, id: string): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    'select status::text as status from proposals where id = $1 and org_id = $2',
    [id, orgId],
  );
  return rows[0]?.status ?? null;
}

const missing = { ok: false, code: 404, message: 'That bid no longer exists.' } as const;
const refused = {
  ok: false,
  code: 403,
  message: 'You do not have permission to change bids in this organisation.',
} as const;

function cannotApprove(status: string): BidChange {
  return {
    ok: false,
    code: 409,
    message:
      status === 'approved'
        ? 'This bid is already approved.'
        : status === 'submitted'
          ? 'This bid has already been sent.'
          : `This bid is ${status}, so it cannot be approved.`,
  };
}

/** queued → approved, by this person, through this channel. */
export async function approveBid(
  db: Queryable,
  actor: BidActor,
  id: string,
  via: BidChannel,
  options: { readonly requestId?: string | null; readonly now?: Date } = {},
): Promise<BidChange> {
  // ARB-410: an approval hands the bid to the sender, so a plan with no room says so now.
  const room = await planUsage(db, {
    orgId: actor.orgId,
    metric: 'bids_submitted',
    ...(options.now ? { now: options.now } : {}),
  });
  if (!room.ok) return { ok: false, code: 402, message: room.message };
  const { rows } = await db.query<{ amount_minor: string; currency: string }>(
    `update proposals
        set status = 'approved', approved_by = $3, approved_via = $4::approval_channel
      where id = $1 and org_id = $2 and status = 'queued'
      returning amount_minor::text, currency::text`,
    [id, actor.orgId, actor.userId, via],
  );
  const row = rows[0];
  if (!row) {
    const status = await currentStatus(db, actor.orgId, id);
    if (status === null) return missing;
    return status === 'queued' ? refused : cannotApprove(status);
  }
  await recordEvent(db, {
    orgId: actor.orgId,
    type: 'proposal.approved',
    actorUserId: actor.userId,
    subjectTable: 'proposals',
    subjectId: id,
    requestId: options.requestId ?? null,
    payload: { via, amount_minor: Number(row.amount_minor), currency: row.currency },
  });
  return { ok: true, statusBefore: 'queued' };
}

/**
 * Anything but sent or already rejected → rejected, with the reason on the bid; an
 * approval it replaces is cleared, as a rejected reply's is. The log keeps the reason's
 * fingerprint, not its words (ARB-520, P-02).
 */
export async function rejectBid(
  db: Queryable,
  actor: BidActor,
  id: string,
  reason: string,
  via: BidChannel,
  options: { readonly requestId?: string | null } = {},
): Promise<BidChange> {
  const { rows } = await db.query<{ status_before: string }>(
    `update proposals p
        set status = 'rejected', failure_reason = $3, approved_by = null, approved_via = null
       from (select id, status::text as status_before from proposals
              where id = $1 and org_id = $2 for update) before
      where p.id = before.id and p.status not in ('submitted', 'rejected')
      returning before.status_before`,
    [id, actor.orgId, reason],
  );
  const row = rows[0];
  if (!row) {
    const status = await currentStatus(db, actor.orgId, id);
    if (status === null) return missing;
    if (status !== 'submitted' && status !== 'rejected') return refused;
    return {
      ok: false,
      code: 409,
      message:
        status === 'submitted'
          ? 'This bid has already been sent.'
          : 'This bid is already rejected.',
    };
  }
  await recordEvent(db, {
    orgId: actor.orgId,
    type: 'proposal.rejected',
    actorUserId: actor.userId,
    subjectTable: 'proposals',
    subjectId: id,
    requestId: options.requestId ?? null,
    payload: { via, reason: textFingerprint(reason), status_before: row.status_before },
  });
  return { ok: true, statusBefore: row.status_before };
}

/**
 * New words for a bid not yet sent. New words need a new approval: the old one covered the
 * old words (D-033), so the bid goes back to queued and its approval and failure clear.
 */
export async function editBid(
  db: Queryable,
  actor: BidActor,
  id: string,
  text: string,
  via: BidChannel,
  options: { readonly requestId?: string | null } = {},
): Promise<BidChange> {
  const { rows } = await db.query<{ status_before: string }>(
    `update proposals p
        set body = $3, status = 'queued', approved_by = null, approved_via = null,
            failure_reason = null
       from (select id, status::text as status_before from proposals
              where id = $1 and org_id = $2 for update) before
      where p.id = before.id and p.status <> 'submitted'
      returning before.status_before`,
    [id, actor.orgId, text],
  );
  const row = rows[0];
  if (!row) {
    const status = await currentStatus(db, actor.orgId, id);
    if (status === null) return missing;
    if (status !== 'submitted') return refused;
    return {
      ok: false,
      code: 409,
      message: 'This bid has already been sent and cannot be changed.',
    };
  }
  await recordEvent(db, {
    orgId: actor.orgId,
    type: 'proposal.edited',
    actorUserId: actor.userId,
    subjectTable: 'proposals',
    subjectId: id,
    requestId: options.requestId ?? null,
    payload: { via, bodyLength: text.length, status_before: row.status_before },
  });
  return { ok: true, statusBefore: row.status_before };
}
