/**
 * Analytics (ARB-320, docs/01 section A step 9: "realised margin, reply rate and win rate
 * per category, template, supplier and search"; section I's analytics page). Each figure
 * is counted over jobs with a submitted bid, one row per job (the `analytics_job_facts`
 * view, 0028), and grouped here so that the API and the demo group the same way.
 *
 *   reply rate  = bids with a client message after the bid ÷ bids
 *   win rate    = won ÷ (won + lost), over the bids decided so far
 *   realised margin = payments in − payments out, in rand (docs/05 section 3.5); a payment
 *                 with no rand figure is counted apart, never guessed
 *   cost per reply  = model spend on the jobs (llm_calls, D-021) ÷ replies, in USD
 *
 * A rate with nothing under it is "no data", never 0 %. Money is summed as BigInt.
 */
export const ANALYTICS_DIMENSIONS = ['category', 'template', 'supplier', 'scanner'] as const;
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

/** What a group with no value is called, per dimension. */
export const ANALYTICS_UNASSIGNED: Readonly<Record<AnalyticsDimension, string>> = {
  category: 'Not classified',
  template: 'No template',
  supplier: 'No supplier',
  scanner: 'No scanner',
};

/** One job with a submitted bid. Money is minor-unit text, as the database returns it. */
export interface JobFacts {
  readonly jobId: string;
  readonly categoryKey: string | null;
  readonly categoryLabel: string | null;
  readonly templateKey: string | null;
  readonly templateLabel: string | null;
  readonly supplierKey: string | null;
  readonly supplierLabel: string | null;
  readonly scannerKey: string | null;
  readonly scannerLabel: string | null;
  readonly replied: boolean;
  readonly won: boolean;
  readonly lost: boolean;
  readonly inZarMinor: string;
  readonly outZarMinor: string;
  readonly unconvertedPayments: number;
  readonly modelCostNanoUsd: string;
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** The percentage to one decimal place, half up, as text ("33.3"); null with no denominator. */
  readonly percent: string | null;
}

export interface AnalyticsRow {
  readonly key: string | null;
  readonly label: string;
  readonly bids: number;
  readonly replies: number;
  readonly replyRate: Ratio;
  readonly won: number;
  readonly lost: number;
  readonly winRate: Ratio;
  readonly realisedMarginZarMinor: string;
  readonly unconvertedPayments: number;
  readonly modelCostNanoUsd: string;
  /** Model spend ÷ replies in nano-USD, rounded half up; null with no replies. */
  readonly costPerReplyNanoUsd: string | null;
}

/** numerator ÷ denominator as a percentage to one decimal place, rounded half up. */
export function ratio(numerator: number, denominator: number): Ratio {
  if (denominator <= 0) return { numerator, denominator, percent: null };
  const tenths = (BigInt(numerator) * 1000n + BigInt(denominator) / 2n) / BigInt(denominator);
  const whole = tenths / 10n;
  const rest = tenths % 10n;
  return { numerator, denominator, percent: `${whole.toString()}.${rest.toString()}` };
}

function keyOf(facts: JobFacts, by: AnalyticsDimension): { key: string | null; label: string } {
  const pair = {
    category: [facts.categoryKey, facts.categoryLabel],
    template: [facts.templateKey, facts.templateLabel],
    supplier: [facts.supplierKey, facts.supplierLabel],
    scanner: [facts.scannerKey, facts.scannerLabel],
  }[by];
  const key = pair[0] ?? null;
  return { key, label: key === null ? ANALYTICS_UNASSIGNED[by] : (pair[1] ?? key) };
}

/** Groups the jobs by one dimension; the biggest groups first, then by name. */
export function aggregateAnalytics(
  facts: readonly JobFacts[],
  by: AnalyticsDimension,
): AnalyticsRow[] {
  interface Sum {
    key: string | null;
    label: string;
    bids: number;
    replies: number;
    won: number;
    lost: number;
    margin: bigint;
    unconverted: number;
    cost: bigint;
  }
  const groups = new Map<string, Sum>();
  for (const f of facts) {
    const { key, label } = keyOf(f, by);
    const id = key === null ? '' : `k:${key}`;
    const sum = groups.get(id) ?? {
      key,
      label,
      bids: 0,
      replies: 0,
      won: 0,
      lost: 0,
      margin: 0n,
      unconverted: 0,
      cost: 0n,
    };
    sum.bids += 1;
    if (f.replied) sum.replies += 1;
    if (f.won) sum.won += 1;
    if (f.lost) sum.lost += 1;
    sum.margin += BigInt(f.inZarMinor) - BigInt(f.outZarMinor);
    sum.unconverted += f.unconvertedPayments;
    sum.cost += BigInt(f.modelCostNanoUsd);
    groups.set(id, sum);
  }
  return [...groups.values()]
    .sort((a, b) => b.bids - a.bids || a.label.localeCompare(b.label))
    .map((s) => ({
      key: s.key,
      label: s.label,
      bids: s.bids,
      replies: s.replies,
      replyRate: ratio(s.replies, s.bids),
      won: s.won,
      lost: s.lost,
      winRate: ratio(s.won, s.won + s.lost),
      realisedMarginZarMinor: s.margin.toString(),
      unconvertedPayments: s.unconverted,
      modelCostNanoUsd: s.cost.toString(),
      costPerReplyNanoUsd:
        s.replies === 0 ? null : ((s.cost + BigInt(s.replies) / 2n) / BigInt(s.replies)).toString(),
    }));
}

/** Every bid together, as one row labelled "All bids". */
export function analyticsTotal(facts: readonly JobFacts[]): AnalyticsRow {
  const [row] = aggregateAnalytics(
    facts.map((f) => ({ ...f, categoryKey: 'all', categoryLabel: 'All bids' })),
    'category',
  );
  return (
    row ?? {
      key: 'all',
      label: 'All bids',
      bids: 0,
      replies: 0,
      replyRate: ratio(0, 0),
      won: 0,
      lost: 0,
      winRate: ratio(0, 0),
      realisedMarginZarMinor: '0',
      unconvertedPayments: 0,
      modelCostNanoUsd: '0',
      costPerReplyNanoUsd: null,
    }
  );
}
