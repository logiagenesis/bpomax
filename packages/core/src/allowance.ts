/**
 * Bid allowance (ARB-042): how many bids the marketplace account may place in a period,
 * against how many it has. The figures are the owner's (docs/02 T-03: plan name and
 * monthly bid limit, recorded on the platform account); this module only judges them.
 */

/** SAST is UTC+2 all year (D-024); a bid period is a calendar month in that time. */
const HOME_OFFSET_MS = 2 * 60 * 60 * 1000;

export interface BidPeriod {
  /** First day of the period, YYYY-MM-DD. What `usage_counters.period_start` holds. */
  readonly start: string;
  /** First day of the next period, YYYY-MM-DD: when the allowance is whole again. */
  readonly resetsOn: string;
}

function isoDay(year: number, monthIndex: number): string {
  return new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);
}

/** The calendar month, in South African time, that `now` falls in. */
export function bidPeriod(now: Date): BidPeriod {
  const local = new Date(now.getTime() + HOME_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return { start: isoDay(year, month), resetsOn: isoDay(year, month + 1) };
}

/** The `usage_counters.metric` for bids on one platform's account. */
export function bidMetric(platform: string): string {
  return `bids:${platform}`;
}

export type AllowanceRefusal = 'no_account' | 'allowance_unknown' | 'allowance_reached';

export type AllowanceVerdict =
  | {
      readonly ok: true;
      readonly used: number;
      readonly limit: number;
      readonly remaining: number;
      readonly period: BidPeriod;
    }
  | {
      readonly ok: false;
      readonly reason: AllowanceRefusal;
      /** Plain language, for the operator: what is blocking and what would clear it. */
      readonly message: string;
      readonly used: number;
      readonly limit: number | null;
      readonly period: BidPeriod;
    };

export interface AllowanceInput {
  readonly platform: string;
  /** Null when no account is connected for the platform. */
  readonly account: { readonly planName: string | null; readonly allowance: number | null } | null;
  /** Bids already counted this period. */
  readonly used: number;
  readonly period: BidPeriod;
}

function dayForPeople(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/**
 * Whether one more bid may be placed. An unknown allowance is a refusal, not a pass: a
 * limit nobody has recorded cannot be assumed generous.
 */
export function checkBidAllowance(input: AllowanceInput): AllowanceVerdict {
  const { platform, account, used, period } = input;
  if (!account) {
    return {
      ok: false,
      reason: 'no_account',
      message: `No ${platform} account is connected, so there is no allowance to bid from.`,
      used,
      limit: null,
      period,
    };
  }
  if (account.allowance === null) {
    return {
      ok: false,
      reason: 'allowance_unknown',
      message:
        `The bid allowance on the ${platform} account has not been recorded (docs/02 T-03: ` +
        'plan name and monthly bid limit). Nothing is submitted until it is.',
      used,
      limit: null,
      period,
    };
  }
  if (used >= account.allowance) {
    const plan = account.planName ? ` on the ${account.planName} plan` : '';
    return {
      ok: false,
      reason: 'allowance_reached',
      message:
        `The ${platform} bid allowance is used up: ${String(used)} of ${String(account.allowance)} ` +
        `bids this period${plan}. It resets on ${dayForPeople(period.resetsOn)}.`,
      used,
      limit: account.allowance,
      period,
    };
  }
  return {
    ok: true,
    used,
    limit: account.allowance,
    remaining: account.allowance - used,
    period,
  };
}
