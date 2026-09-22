import { bidPeriod } from '@arbitron/core';
import { withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../context.js';

/**
 * The dashboard figures (ARB-061, docs/01 section I): month-to-date revenue in and out,
 * margin, pipeline value, replies, win rate and the retainer total.
 *
 * Every figure here is a sum or a count over stored rows, with the formula written
 * beside it (05 section 3.3). Money is summed in the database and returned as text, so
 * no float ever touches it; the page formats the string with BigInt arithmetic.
 *
 * The month is the South African calendar month (D-024, D-030), from the first at
 * 00:00 SAST to the moment of the request.
 */
export interface MoneyByCurrency {
  readonly currency: string;
  readonly amountMinor: string;
  readonly count: number;
}

export interface Dashboard {
  readonly period: { readonly start: string; readonly end: string };
  readonly currency: 'ZAR';
  /** Sum of payments in, paid this month, in ZAR: `amount_zar_minor`, or `amount_minor` when the payment is in ZAR. */
  readonly revenueInZarMinor: string;
  /** The same over payments out. */
  readonly revenueOutZarMinor: string;
  /** revenueIn − revenueOut. Fees are recorded as payments out (docs/05 section 3.5); the fee lines themselves arrive with ARB-311. */
  readonly realisedMarginZarMinor: string;
  /** Payments this month in another currency with no stored ZAR figure: counted, never guessed into rand. */
  readonly unconverted: readonly (MoneyByCurrency & { readonly direction: 'in' | 'out' })[];
  /** Sum of `value_minor` over pipeline items in an open stage (applied → delivered), per currency. */
  readonly pipeline: readonly MoneyByCurrency[];
  /** Messages received this month (`messages.direction = 'in'`). */
  readonly replies: number;
  readonly bids: {
    /** Proposals waiting for approval now. */
    readonly queued: number;
    /** Proposals sent this month. */
    readonly submitted: number;
    /** Pipeline items that reached won or later this month. */
    readonly won: number;
    /** Pipeline items marked lost this month. */
    readonly lost: number;
  };
  /** won ÷ (won + lost) over the items decided this month, or null when none were. */
  readonly winRate: number | null;
  /** Sum of `retainer_monthly_minor` over retainers not lost, per currency. */
  readonly retainers: readonly MoneyByCurrency[];
}

const OPEN_STAGES = `('applied', 'replied', 'discovery', 'briefed', 'sourcing', 'won', 'in_delivery', 'delivered')`;
const WON_STAGES = `('won', 'in_delivery', 'delivered', 'paid')`;

export async function readDashboard(tx: Queryable, now: Date): Promise<Dashboard> {
  const period = bidPeriod(now);
  const monthStart = new Date(`${period.start}T00:00:00+02:00`).toISOString();
  const end = now.toISOString();

  const money = await tx.query<{ direction: 'in' | 'out'; zar: string }>(
    `select direction::text as direction,
            coalesce(sum(case when currency = 'ZAR' then amount_minor else amount_zar_minor end), 0)::text as zar
     from payments
     where paid_at >= $1 and paid_at <= $2
       and (currency = 'ZAR' or amount_zar_minor is not null)
     group by direction`,
    [monthStart, end],
  );
  const zar = (direction: 'in' | 'out'): string =>
    money.rows.find((row) => row.direction === direction)?.zar ?? '0';
  const revenueIn = zar('in');
  const revenueOut = zar('out');

  const unconverted = await tx.query<{
    direction: 'in' | 'out';
    currency: string;
    amount: string;
    n: string;
  }>(
    `select direction::text as direction, currency, sum(amount_minor)::text as amount, count(*)::text as n
     from payments
     where paid_at >= $1 and paid_at <= $2 and currency <> 'ZAR' and amount_zar_minor is null
     group by direction, currency order by direction, currency`,
    [monthStart, end],
  );

  const pipeline = await tx.query<{ currency: string; amount: string; n: string }>(
    `select currency, sum(value_minor)::text as amount, count(*)::text as n
     from pipeline_items
     where stage in ${OPEN_STAGES} and value_minor is not null and currency is not null
     group by currency order by currency`,
  );

  const replies = await tx.query<{ n: string }>(
    `select count(*)::text as n from messages where direction = 'in' and created_at >= $1 and created_at <= $2`,
    [monthStart, end],
  );

  const bids = await tx.query<{ queued: string; submitted: string }>(
    `select count(*) filter (where status = 'queued')::text as queued,
            count(*) filter (where status = 'submitted' and submitted_at >= $1 and submitted_at <= $2)::text as submitted
     from proposals`,
    [monthStart, end],
  );

  const decided = await tx.query<{ won: string; lost: string }>(
    `select count(*) filter (where stage in ${WON_STAGES})::text as won,
            count(*) filter (where stage = 'lost')::text as lost
     from pipeline_items
     where stage_changed_at >= $1 and stage_changed_at <= $2`,
    [monthStart, end],
  );

  const retainers = await tx.query<{ currency: string; amount: string; n: string }>(
    `select currency, sum(retainer_monthly_minor)::text as amount, count(*)::text as n
     from pipeline_items
     where retainer and stage <> 'lost' and currency is not null
     group by currency order by currency`,
  );

  const won = Number(decided.rows[0]?.won ?? 0);
  const lost = Number(decided.rows[0]?.lost ?? 0);

  return {
    period: { start: monthStart, end },
    currency: 'ZAR',
    revenueInZarMinor: revenueIn,
    revenueOutZarMinor: revenueOut,
    realisedMarginZarMinor: (BigInt(revenueIn) - BigInt(revenueOut)).toString(),
    unconverted: unconverted.rows.map((row) => ({
      direction: row.direction,
      currency: row.currency,
      amountMinor: row.amount,
      count: Number(row.n),
    })),
    pipeline: pipeline.rows.map((row) => ({
      currency: row.currency,
      amountMinor: row.amount,
      count: Number(row.n),
    })),
    replies: Number(replies.rows[0]?.n ?? 0),
    bids: {
      queued: Number(bids.rows[0]?.queued ?? 0),
      submitted: Number(bids.rows[0]?.submitted ?? 0),
      won,
      lost,
    },
    winRate: won + lost === 0 ? null : won / (won + lost),
    retainers: retainers.rows.map((row) => ({
      currency: row.currency,
      amountMinor: row.amount,
      count: Number(row.n),
    })),
  };
}

export function registerDashboardRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/dashboard', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const now = options.now ? options.now() : new Date();
    const dashboard = await withUser(options.db, authUserId, (tx) => readDashboard(tx, now));
    return reply.send(dashboard);
  });
}
