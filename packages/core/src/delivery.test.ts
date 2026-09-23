import { describe, expect, it } from 'vitest';
import {
  handoverChecklist,
  milestoneTotal,
  pipelineStageFor,
  reconcileMilestones,
  transitionBlockers,
  validateDeliveryOrderEdit,
  validateRetainer,
  type DeliveryMilestone,
  type TransitionState,
} from './delivery.js';

/**
 * ARB-310 acceptance: "Milestone totals reconcile to agreed cost". Every figure is worked
 * by hand in the comment beside it; the amounts are test data.
 */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');
const m = (amountMinor: number, status: DeliveryMilestone['status'] = 'pending') => ({
  title: `Part ${String(amountMinor)}`,
  amountMinor,
  due: null,
  status,
});

describe('milestone totals', () => {
  it('sums exactly in cents, beyond the float range', () => {
    // R3 000,00 + R3 000,00 + R3 000,50 = R9 000,50.
    expect(milestoneTotal([m(300_000), m(300_000), m(300_050)])).toBe(900_050n);
    expect(milestoneTotal([m(Number.MAX_SAFE_INTEGER), m(Number.MAX_SAFE_INTEGER)])).toBe(
      2n * BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it('reconciles to the cent, and says by how much it does not', () => {
    expect(reconcileMilestones([m(450_025), m(450_025)], 900_050, 'ZAR')).toEqual({
      ok: true,
      totalMinor: 900_050n,
    });
    // R4 500,00 + R4 500,00 = R9 000,00 against R9 000,50: one cent short per half, 50c in all.
    const short = reconcileMilestones([m(450_000), m(450_000)], 900_050, 'ZAR');
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.differenceMinor).toBe(-50n);
    expect(plain(short.message)).toBe(
      'The milestones add up to R9 000,00; the agreed cost is R9 000,50. They must be equal.',
    );
  });
});

describe('validateDeliveryOrderEdit', () => {
  const good = {
    agreedCostMinor: 900_050,
    currency: 'zar',
    due: '2026-10-30',
    milestones: [
      { title: ' Design ', amountMinor: 300_000, due: '2026-10-09' },
      { title: 'Build', amountMinor: 600_050, due: null, status: 'delivered' },
    ],
  };

  it('accepts reconciled milestones, trims and upper-cases, and defaults a status to pending', () => {
    const result = validateDeliveryOrderEdit(good);
    expect(result).toEqual({
      ok: true,
      value: {
        agreedCostMinor: 900_050,
        currency: 'ZAR',
        due: '2026-10-30',
        milestones: [
          { title: 'Design', amountMinor: 300_000, due: '2026-10-09', status: 'pending' },
          { title: 'Build', amountMinor: 600_050, due: null, status: 'delivered' },
        ],
      },
    });
  });

  it('refuses milestones that do not add up, on the milestones field, in money words', () => {
    const result = validateDeliveryOrderEdit({ ...good, agreedCostMinor: 1_000_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe('milestones');
    expect(plain(result.errors[0]!.message)).toBe(
      'The milestones add up to R9 000,50; the agreed cost is R10 000,00. They must be equal.',
    );
  });

  it('names every bad field: fractions of a cent, a zero milestone, a false date, no title', () => {
    const result = validateDeliveryOrderEdit({
      agreedCostMinor: 12.5,
      currency: 'rand',
      due: '2026-02-30',
      milestones: [
        { title: '', amountMinor: 0 },
        { title: 'x'.repeat(121), amountMinor: 100, due: '30/10/2026', status: 'paid' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual([
      'agreedCostMinor',
      'currency',
      'due',
      'milestones[0].title',
      'milestones[0].amountMinor',
      'milestones[1].title',
      'milestones[1].due',
      'milestones[1].status',
    ]);
  });

  it('needs at least one milestone and at most twenty', () => {
    expect(validateDeliveryOrderEdit({ ...good, milestones: [] })).toMatchObject({
      ok: false,
      errors: [{ field: 'milestones', message: 'must have at least one milestone' }],
    });
    const many = Array.from({ length: 21 }, () => ({ title: 'a', amountMinor: 1 }));
    expect(
      validateDeliveryOrderEdit({ agreedCostMinor: 21, currency: 'ZAR', milestones: many }),
    ).toMatchObject({ ok: false, errors: [{ field: 'milestones' }] });
  });
});

describe('the handover checklist', () => {
  it('is read from the brief, in a fixed order with stable keys, and names no client', () => {
    const items = handoverChecklist({
      mustHaves: ['Checkout', 'Stock sync'],
      acceptanceCriteria: ['Orders go through', 'Loads in under 3 s'],
      techConstraints: ['Shopify'],
      assetsProvided: ['Logo files'],
      assetsMissing: ['Product photos'],
      deadline: '2026-10-30',
      deadlineFixed: true,
    });
    expect(items.map((i) => i.key)).toEqual([
      'scope',
      'acceptance-1',
      'acceptance-2',
      'constraint-1',
      'asset-1',
      'missing-1',
      'deadline',
      'milestones',
    ]);
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items[0]?.text).toBe(
      'Share the brief’s scope with the supplier: the outcome and 2 must-haves, without the client’s name or contact details.',
    );
    expect(items[2]?.text).toBe(
      'The supplier confirms this acceptance criterion: Loads in under 3 s',
    );
    expect(items[6]?.text).toBe(
      'Agree a delivery date before the client’s deadline of 30/10/2026, which is fixed.',
    );
  });

  it('with no deadline or assets, keeps the scope and the milestones', () => {
    expect(
      handoverChecklist({
        mustHaves: ['One'],
        acceptanceCriteria: [],
        techConstraints: [],
        assetsProvided: [],
        assetsMissing: [],
        deadline: null,
        deadlineFixed: null,
      }).map((i) => i.key),
    ).toEqual(['scope', 'milestones']);
  });
});

describe('moving an order', () => {
  const base: TransitionState = {
    status: 'draft',
    supplierChosen: true,
    agreedCostMinor: 900_000,
    currency: 'ZAR',
    milestones: [m(300_000), m(600_000)],
    handover: [{ key: 'scope', text: 'x', done: false }],
    pipelineStage: 'won',
  };

  it('assigns a chosen supplier on a won job with reconciled milestones, and says what is missing otherwise', () => {
    expect(transitionBlockers(base, 'assigned')).toEqual([]);
    expect(
      transitionBlockers(
        { ...base, supplierChosen: false, pipelineStage: 'applied', milestones: [m(300_000)] },
        'assigned',
      ).map(plain),
    ).toEqual([
      'No supplier is chosen for this order.',
      'The job is not won yet (its stage is applied), so no supplier is assigned.',
      'The milestones add up to R3 000,00; the agreed cost is R9 000,00. They must be equal.',
    ]);
  });

  it('starts only once the handover is complete; delivers and accepts milestone by milestone', () => {
    const assigned = { ...base, status: 'assigned' as const };
    expect(transitionBlockers(assigned, 'in_progress')).toEqual([
      '1 handover item is not ticked yet; the supplier starts once the handover is complete.',
    ]);
    expect(
      transitionBlockers(
        { ...assigned, handover: [{ key: 'scope', text: 'x', done: true }] },
        'in_progress',
      ),
    ).toEqual([]);
    const working = { ...base, status: 'in_progress' as const };
    expect(transitionBlockers(working, 'delivered')).toEqual([
      '2 milestones are not delivered yet.',
    ]);
    const delivered = {
      ...base,
      status: 'delivered' as const,
      milestones: [m(300_000, 'accepted'), m(600_000, 'delivered')],
    };
    expect(transitionBlockers(delivered, 'accepted')).toEqual(['1 milestone is not accepted yet.']);
  });

  it('goes forward only; cancels before delivery, never after', () => {
    expect(transitionBlockers(base, 'delivered')).toEqual([
      'A draft order cannot be moved to delivered.',
    ]);
    expect(transitionBlockers({ ...base, status: 'in_progress' }, 'cancelled')).toEqual([]);
    expect(transitionBlockers({ ...base, status: 'delivered' }, 'cancelled')).toEqual([
      'A delivered order cannot be moved to cancelled.',
    ]);
    expect(pipelineStageFor('in_progress')).toBe('in_delivery');
    expect(pipelineStageFor('delivered')).toBe('delivered');
    expect(pipelineStageFor('assigned')).toBeNull();
  });
});

describe('a retainer', () => {
  it('has a monthly amount above zero, and a job that is not one has none', () => {
    // R4 500,00 a month.
    expect(validateRetainer({ retainer: true, retainerMonthlyMinor: 450_000 })).toEqual({
      ok: true,
      value: { retainer: true, retainerMonthlyMinor: 450_000 },
    });
    expect(validateRetainer({ retainer: false, retainerMonthlyMinor: 450_000 })).toEqual({
      ok: true,
      value: { retainer: false, retainerMonthlyMinor: null },
    });
    for (const amount of [0, -1, 12.5, null, '450000']) {
      expect(validateRetainer({ retainer: true, retainerMonthlyMinor: amount })).toMatchObject({
        ok: false,
        errors: [{ field: 'retainerMonthlyMinor' }],
      });
    }
    expect(validateRetainer({ retainer: 'yes' })).toMatchObject({
      ok: false,
      errors: [{ field: 'retainer' }],
    });
  });
});
