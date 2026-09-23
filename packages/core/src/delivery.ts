import type { BriefInput } from './brief.js';
import { formatMoney } from './money.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Delivery orders (ARB-310, docs/01 section A step 8: "track the won job through
 * milestones, supplier handover, client delivery and payment"). The order's milestones
 * are what we pay the supplier against, so they must add up to the agreed cost to the
 * cent before a supplier is assigned (the ticket's acceptance: "Milestone totals
 * reconcile to agreed cost"). Money in whole minor units, summed as BigInt (05 section
 * 3.2). The handover checklist is read from the locked brief: nothing on it is invented,
 * and nothing on it names the client (D-054's rule for anything a supplier sees).
 */
export const DELIVERY_STATUSES = [
  'draft',
  'assigned',
  'in_progress',
  'delivered',
  'accepted',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The pipeline's stages (docs/01 section D, `pipeline_items.stage`), in board order. */
export const PIPELINE_STAGES = [
  'applied',
  'replied',
  'discovery',
  'briefed',
  'sourcing',
  'won',
  'in_delivery',
  'delivered',
  'paid',
  'lost',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const MILESTONE_STATUSES = ['pending', 'delivered', 'accepted'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const MAX_DELIVERY_MILESTONES = 20;
export const MAX_MILESTONE_TITLE = 120;

export interface DeliveryMilestone {
  readonly title: string;
  readonly amountMinor: number;
  /** ISO `YYYY-MM-DD`, or null when no date is agreed. */
  readonly due: string | null;
  readonly status: MilestoneStatus;
}

export interface HandoverItem {
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

export interface DeliveryOrderEdit {
  readonly agreedCostMinor: number;
  readonly currency: string;
  readonly milestones: DeliveryMilestone[];
  /** ISO `YYYY-MM-DD`, or null. */
  readonly due: string | null;
}

/** Which statuses an order may move to from each: forward only, and cancel before delivery. */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  draft: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: ['accepted'],
  accepted: [],
  cancelled: [],
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function realDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

/** The milestones' total in minor units, summed exactly. */
export function milestoneTotal(milestones: readonly { readonly amountMinor: number }[]): bigint {
  return milestones.reduce((sum, m) => sum + BigInt(m.amountMinor), 0n);
}

/**
 * Whether the milestones add up to the agreed cost, and if not, by how much, in words.
 * `differenceMinor` is the total less the agreed cost: positive when the milestones
 * would pay more than agreed.
 */
export function reconcileMilestones(
  milestones: readonly { readonly amountMinor: number }[],
  agreedCostMinor: number,
  currency: string,
):
  | { readonly ok: true; readonly totalMinor: bigint }
  | {
      readonly ok: false;
      readonly totalMinor: bigint;
      readonly differenceMinor: bigint;
      readonly message: string;
    } {
  const totalMinor = milestoneTotal(milestones);
  const differenceMinor = totalMinor - BigInt(agreedCostMinor);
  if (differenceMinor === 0n) return { ok: true, totalMinor };
  return {
    ok: false,
    totalMinor,
    differenceMinor,
    message: `The milestones add up to ${formatMoney(totalMinor, currency)}; the agreed cost is ${formatMoney(agreedCostMinor, currency)}. They must be equal.`,
  };
}

/**
 * Reads an order's cost, currency, milestones and due date, with the same rule the API
 * and the page apply: every amount whole minor units above zero, every date a real day,
 * and the milestones reconciled to the agreed cost.
 */
export function validateDeliveryOrderEdit(input: unknown): ValidationResult<DeliveryOrderEdit> {
  const errors: FieldError[] = [];
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const cost = raw.agreedCostMinor;
  let agreedCostMinor: number | null = null;
  if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0)
    errors.push({ field: 'agreedCostMinor', message: 'must be whole cents, 0 or more' });
  else agreedCostMinor = cost;

  let currency: string | null = null;
  if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency.trim().toUpperCase()))
    errors.push({ field: 'currency', message: 'must be a three-letter currency code' });
  else currency = raw.currency.trim().toUpperCase();

  let due: string | null = null;
  if (raw.due !== undefined && raw.due !== null && raw.due !== '') {
    if (typeof raw.due !== 'string' || !realDate(raw.due))
      errors.push({ field: 'due', message: 'must be a real date' });
    else due = raw.due;
  }

  const milestones: DeliveryMilestone[] = [];
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) {
    errors.push({ field: 'milestones', message: 'must have at least one milestone' });
  } else if (raw.milestones.length > MAX_DELIVERY_MILESTONES) {
    errors.push({
      field: 'milestones',
      message: `must have ${String(MAX_DELIVERY_MILESTONES)} milestones or fewer`,
    });
  } else {
    raw.milestones.forEach((item: unknown, index) => {
      const m = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      const at = `milestones[${String(index)}]`;
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      if (!title) errors.push({ field: `${at}.title`, message: 'must not be empty' });
      else if (title.length > MAX_MILESTONE_TITLE)
        errors.push({
          field: `${at}.title`,
          message: `must be ${String(MAX_MILESTONE_TITLE)} characters or fewer`,
        });
      const amount = m.amountMinor;
      const amountOk = typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
      if (!amountOk)
        errors.push({ field: `${at}.amountMinor`, message: 'must be whole cents above 0' });
      let mDue: string | null = null;
      if (m.due !== undefined && m.due !== null && m.due !== '') {
        if (typeof m.due !== 'string' || !realDate(m.due))
          errors.push({ field: `${at}.due`, message: 'must be a real date' });
        else mDue = m.due;
      }
      const status = m.status === undefined ? 'pending' : m.status;
      if (!MILESTONE_STATUSES.includes(status as MilestoneStatus))
        errors.push({
          field: `${at}.status`,
          message: `must be one of ${MILESTONE_STATUSES.join(', ')}`,
        });
      milestones.push({
        title,
        amountMinor: amountOk ? amount : 0,
        due: mDue,
        status: status as MilestoneStatus,
      });
    });
  }

  if (errors.length === 0 && agreedCostMinor !== null && currency !== null) {
    const check = reconcileMilestones(milestones, agreedCostMinor, currency);
    if (!check.ok) errors.push({ field: 'milestones', message: check.message });
  }
  if (errors.length > 0 || agreedCostMinor === null || currency === null)
    return { ok: false, errors };
  return { ok: true, value: { agreedCostMinor, currency, milestones, due } };
}

/** DD/MM/YYYY for an ISO day, the one date format on a page (docs/01 section I). */
function day(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * The supplier handover checklist, read from the locked brief (docs/01 section F): the
 * scope to share, each acceptance criterion and technical constraint for the supplier to
 * confirm, each asset to hand over or still owed by the client, the deadline, and the
 * milestones agreed in writing. Keys are stable, so a tick survives a re-read.
 */
export function handoverChecklist(
  brief: Pick<
    BriefInput,
    | 'mustHaves'
    | 'acceptanceCriteria'
    | 'assetsProvided'
    | 'assetsMissing'
    | 'techConstraints'
    | 'deadline'
    | 'deadlineFixed'
  >,
): HandoverItem[] {
  const items: HandoverItem[] = [
    {
      key: 'scope',
      text: `Share the brief’s scope with the supplier: the outcome and ${String(brief.mustHaves.length)} must-have${brief.mustHaves.length === 1 ? '' : 's'}, without the client’s name or contact details.`,
      done: false,
    },
  ];
  brief.acceptanceCriteria.forEach((text, i) =>
    items.push({
      key: `acceptance-${String(i + 1)}`,
      text: `The supplier confirms this acceptance criterion: ${text}`,
      done: false,
    }),
  );
  brief.techConstraints.forEach((text, i) =>
    items.push({
      key: `constraint-${String(i + 1)}`,
      text: `The supplier confirms this technical constraint: ${text}`,
      done: false,
    }),
  );
  brief.assetsProvided.forEach((text, i) =>
    items.push({ key: `asset-${String(i + 1)}`, text: `Hand over: ${text}`, done: false }),
  );
  brief.assetsMissing.forEach((text, i) =>
    items.push({
      key: `missing-${String(i + 1)}`,
      text: `Still owed by the client; tell the supplier when it will come: ${text}`,
      done: false,
    }),
  );
  if (brief.deadline)
    items.push({
      key: 'deadline',
      text: `Agree a delivery date before the client’s deadline of ${day(brief.deadline)}${brief.deadlineFixed === true ? ', which is fixed' : brief.deadlineFixed === false ? ', which can move' : ''}.`,
      done: false,
    });
  items.push({
    key: 'milestones',
    text: 'Agree the milestones and the cost with the supplier in writing.',
    done: false,
  });
  return items;
}

export interface TransitionState {
  readonly status: DeliveryStatus;
  readonly supplierChosen: boolean;
  readonly agreedCostMinor: number | null;
  readonly currency: string | null;
  readonly milestones: readonly DeliveryMilestone[];
  readonly handover: readonly HandoverItem[];
  /** The pipeline stage of the job: a supplier is assigned only once the job is won. */
  readonly pipelineStage: string;
}

/** Stages at or after winning the job. */
const WON_STAGES = ['won', 'in_delivery', 'delivered', 'paid'];

/**
 * Why an order may not move to `to` yet, each reason a sentence; empty when it may.
 */
export function transitionBlockers(order: TransitionState, to: DeliveryStatus): string[] {
  if (!DELIVERY_TRANSITIONS[order.status].includes(to)) {
    const from = order.status.replace('_', ' ');
    return [
      `${/^[aeiou]/.test(from) ? 'An' : 'A'} ${from} order cannot be moved to ${to.replace('_', ' ')}.`,
    ];
  }
  const reasons: string[] = [];
  if (to === 'assigned') {
    if (!order.supplierChosen) reasons.push('No supplier is chosen for this order.');
    if (!WON_STAGES.includes(order.pipelineStage))
      reasons.push(
        `The job is not won yet (its stage is ${order.pipelineStage.replace('_', ' ')}), so no supplier is assigned.`,
      );
    if (order.agreedCostMinor === null || order.currency === null)
      reasons.push('The agreed cost is not set.');
    else {
      const check = reconcileMilestones(order.milestones, order.agreedCostMinor, order.currency);
      if (order.milestones.length === 0) reasons.push('The order has no milestones.');
      else if (!check.ok) reasons.push(check.message);
    }
  }
  if (to === 'in_progress') {
    const open = order.handover.filter((item) => !item.done).length;
    if (open > 0)
      reasons.push(
        `${String(open)} handover item${open === 1 ? ' is' : 's are'} not ticked yet; the supplier starts once the handover is complete.`,
      );
  }
  if (to === 'delivered') {
    const open = order.milestones.filter((m) => m.status === 'pending').length;
    if (open > 0)
      reasons.push(`${String(open)} milestone${open === 1 ? ' is' : 's are'} not delivered yet.`);
  }
  if (to === 'accepted') {
    const open = order.milestones.filter((m) => m.status !== 'accepted').length;
    if (open > 0)
      reasons.push(`${String(open)} milestone${open === 1 ? ' is' : 's are'} not accepted yet.`);
  }
  return reasons;
}

/** The pipeline stage an order's move takes the job to, if it moves it at all. */
export function pipelineStageFor(to: DeliveryStatus): string | null {
  if (to === 'in_progress') return 'in_delivery';
  if (to === 'delivered') return 'delivered';
  return null;
}

export interface RetainerEdit {
  readonly retainer: boolean;
  /** Whole minor units of the job's currency each month; null when not a retainer. */
  readonly retainerMonthlyMinor: number | null;
}

/**
 * A job's retainer (ARB-312, docs/01 section I: the pipeline's "retainer toggle"): a
 * retainer has a monthly amount above zero, and a job that is not one has none. The
 * database holds the first half too (0005's `retainer_has_an_amount`).
 */
export function validateRetainer(input: unknown): ValidationResult<RetainerEdit> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof raw.retainer !== 'boolean')
    return { ok: false, errors: [{ field: 'retainer', message: 'must be true or false' }] };
  if (!raw.retainer) return { ok: true, value: { retainer: false, retainerMonthlyMinor: null } };
  const amount = raw.retainerMonthlyMinor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0)
    return {
      ok: false,
      errors: [
        {
          field: 'retainerMonthlyMinor',
          message: 'must be the monthly amount in whole cents above 0',
        },
      ],
    };
  return { ok: true, value: { retainer: true, retainerMonthlyMinor: amount } };
}
